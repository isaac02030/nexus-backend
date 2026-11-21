// ============================================
// NEXUS — Rotas de Check-ins
// Registo diário de progresso + pontuação
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const {
  DIFFICULT_DAY_LIMIT,
  DIFFICULT_MINIMUM_MESSAGE,
  validateDifficultDay
} = require('../lib/difficult-days');
const { calculateRecoveryState } = require('../lib/recovery-state');
const { classifyNote } = require('../lib/crisis-filter');
const { validateNoteLimit } = require('../lib/note-limit');
const {
  getLegacyMissionDayNumber,
  getMissionDayNumber,
  resolveReminderSettings
} = require('../lib/reminder-schedule');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

function missionParticipantWhere(alias = 'm', userParam = '$2') {
  return `(
    ${alias}.user_id = ${userParam}
    OR ${alias}.partner_id = ${userParam}
  )`;
}

function getProofValidation(proofMode, note) {
  const text = (note || '').trim();

  if (proofMode === 'workout_proof' && text.length < 8) {
    return 'Esta missao exige uma prova curta antes do check-in.';
  }

  if (proofMode === 'study_note' && text.length < 12) {
    return 'Esta missao de estudo exige uma nota curta com o que estudaste hoje.';
  }

  if (proofMode === 'artifact_note' && text.length < 12) {
    return 'Esta missao exige um registo curto do que produziste hoje.';
  }

  if (proofMode === 'text_note' && text.length < 8) {
    return 'Esta missao exige uma nota curta antes do check-in.';
  }

  return null;
}

function isDifficultDay(row) {
  return row.is_difficult === true;
}

function withDifficultFlag(row) {
  return {
    ...row,
    difficult: isDifficultDay(row)
  };
}

// O mesmo corte dos avisos: fuso da pessoa só quando o horário também foi
// escolhido. Fuso vazio, ou horário sem fuso, fica no relógio do servidor.
function dayNumberFor(startedAt, reminderTime, timezone, now = new Date()) {
  const settings = resolveReminderSettings(reminderTime, timezone);
  if (settings.mode === 'chosen') {
    return getMissionDayNumber(startedAt, now, settings.zone);
  }
  return getLegacyMissionDayNumber(startedAt, now);
}

async function reminderClock(userId, executor) {
  const result = await executor.query(
    `SELECT to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || {};
}

async function missionDayNumber(mission, userId, executor = db, now = new Date()) {
  const clock = await reminderClock(userId, executor);
  return dayNumberFor(mission.started_at, clock.reminder_time, clock.timezone, now);
}

function sameId(left, right) {
  return right != null && Number(left) === Number(right);
}

function calculateBrio(doneDays, todayDay, streak) {
  const completedDays = doneDays.size;
  const totalDays = Math.max(todayDay, 1);
  const consistency = Math.round((completedDays / totalDays) * 100);

  let recoveredAfterMiss = false;
  let seenMiss = false;
  for (let day = 1; day <= todayDay; day++) {
    if (doneDays.has(day)) {
      if (seenMiss) {
        recoveredAfterMiss = true;
        break;
      }
    } else {
      seenMiss = true;
    }
  }

  const consistencyPart = Math.round(consistency * 0.6);
  const streakPart = Math.min(streak * 6, 24);
  const recoveryPart = completedDays === 0 ? 0 : (recoveredAfterMiss ? 16 : 8);
  const brio = Math.min(100, consistencyPart + streakPart + recoveryPart);

  return { brio, consistency, recovered: recoveredAfterMiss };
}

// Campos de crise que vão em TODA resposta deste pedido quando o filtro
// dispara (sucesso ou erro), para o site abrir a tela de ajuda.
// Sem disparo, a resposta fica igual à de antes.
function crisisFields(level) {
  return level ? { crisis: true, crisis_level: level } : {};
}

router.post('/', auth, async (req, res) => {
  const { mission_id, difficult } = req.body;
  const userId = req.user.userId;
  const wantsDifficult = difficult === true;

  // Filtro de crise antes de tudo. Se dispara, a nota é descartada aqui:
  // não vai para o banco, nem para log, nem para a IA (que lê do banco).
  // O check-in segue sem penalidade e sem exigir a prova escrita.
  const crisisLevel = classifyNote(req.body.note);
  const note = crisisLevel ? null : req.body.note;
  const reply = (status, body) => res.status(status).json({ ...body, ...crisisFields(crisisLevel) });

  if (!mission_id) {
    return reply(400, { error: 'mission_id é obrigatório.' });
  }

  try {
    const missionRes = await db.query(
      `SELECT * FROM missions m
       WHERE id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [mission_id, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) return reply(404, { error: 'Missão não encontrada.' });
    if (mission.status !== 'active') return reply(400, { error: 'Missão não está ativa.' });
    // Limite de 280 caracteres, depois do filtro de crise (nota com crise
    // já virou null acima) e depois de conferir que a pessoa é da missão.
    const noteError = validateNoteLimit(note);
    if (noteError) return reply(400, { error: noteError });
    // Dia difícil: o mínimo do contrato continua, mas a prova é um toque
    // («Fiz o mínimo», campo minimum_done: true). A frase fica opcional.
    // O check-in comum continua a exigir a prova do contrato.
    if (wantsDifficult && req.body.minimum_done !== true) {
      return reply(400, { error: DIFFICULT_MINIMUM_MESSAGE });
    }
    const proofError = (crisisLevel || wantsDifficult)
      ? null
      : getProofValidation(mission.proof_mode, note);
    if (proofError) {
      return reply(400, { error: proofError });
    }

    // Comum e difícil usam a mesma transação e a mesma trava da missão.
    // O dia é calculado depois da trava, para dois pedidos não somarem
    // o ponto duas vezes nem passarem de 4 ou de 2 seguidos.
    const recorded = await recordCheckin({
      mission, userId, note, wantsDifficult, clearNote: Boolean(crisisLevel)
    });
    return reply(recorded.status, recorded.body);

  } catch (err) {
    // Sem log do erro aqui: nada do pedido (nem a nota) vai para o console.
    reply(500, { error: 'Erro ao registar check-in.' });
  }
});

router.get('/:missionId', auth, async (req, res) => {
  try {
    const missionRes = await db.query(
      `SELECT * FROM missions m
       WHERE m.id = $1 AND ${missionParticipantWhere('m', '$2')}`,
      [req.params.missionId, req.user.userId]
    );
    if (!missionRes.rows[0]) return res.status(404).json({ error: 'Missão não encontrada.' });

    const pairRes = await db.query(
      `SELECT mission_a_id, mission_b_id
       FROM mission_matches
       WHERE status = 'active' AND (mission_a_id = $1 OR mission_b_id = $1)
       LIMIT 1`,
      [req.params.missionId]
    );
    const pair = pairRes.rows[0];
    const missionIds = [Number(req.params.missionId)];
    if (pair) {
      missionIds.push(Number(pair.mission_a_id) === Number(req.params.missionId)
        ? Number(pair.mission_b_id)
        : Number(pair.mission_a_id));
    }

    const result = await db.query(
      `SELECT c.*, u.username FROM checkins c
       JOIN users u ON c.user_id = u.id
       WHERE c.mission_id = ANY($1::int[])
       ORDER BY c.created_at ASC, c.id ASC`,
      [missionIds]
    );

    const byUser = result.rows.reduce((acc, row) => {
      if (!acc[row.user_id]) acc[row.user_id] = { username: row.username, checkins: [] };
      acc[row.user_id].checkins.push({
        day: row.day_number,
        completed: row.completed,
        note: row.note,
        difficult: isDifficultDay(row)
      });
      return acc;
    }, {});

    res.json({ progress: byUser });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter progresso.' });
  }
});

router.get('/:missionId/score', auth, async (req, res) => {
  try {
    const missionRes = await db.query(
      `SELECT m.*, u1.username AS user_name, u2.username AS partner_name
       FROM missions m
       LEFT JOIN users u1 ON m.user_id    = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [req.params.missionId, req.user.userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    const pairRes = await db.query(
      `SELECT mission_a_id, mission_b_id, started_at
       FROM mission_matches
       WHERE status = 'active' AND (mission_a_id = $1 OR mission_b_id = $1)
       LIMIT 1`,
      [req.params.missionId]
    );
    const pair = pairRes.rows[0];
    const partnerMissionId = pair
      ? Number(pair.mission_a_id) === Number(mission.id)
        ? pair.mission_b_id
        : pair.mission_a_id
      : mission.id;
    const scoresRes = await db.query(
      `SELECT mission_id, user_id, COUNT(*) AS days_completed
       FROM checkins
       WHERE mission_id = ANY($1::int[]) AND completed = true
         AND ($2::timestamp IS NULL OR created_at >= $2)
       GROUP BY mission_id, user_id`,
      [[mission.id, partnerMissionId], pair?.started_at || null]
    );
    const ownScore = scoresRes.rows.find(row => Number(row.mission_id) === Number(mission.id)
      && Number(row.user_id) === Number(mission.user_id));
    const partnerMissionRes = pair
      ? await db.query('SELECT user_id FROM missions WHERE id = $1', [partnerMissionId])
      : null;
    const partnerUserId = pair ? partnerMissionRes.rows[0]?.user_id : mission.partner_id;
    const partnerScore = scoresRes.rows.find(row => Number(row.mission_id) === Number(partnerMissionId)
      && Number(row.user_id) === Number(partnerUserId));
    const scores = {
      [mission.user_id]: Number(ownScore?.days_completed || 0),
      [partnerUserId]: Number(partnerScore?.days_completed || 0)
    };

    // Calcular sequência atual (dias consecutivos a partir do dia de hoje)
    let myStreak = 0;
    if (mission.started_at) {
      const currentDay = await missionDayNumber(mission, req.user.userId);

      const streakRes = await db.query(
        `SELECT day_number FROM checkins
         WHERE mission_id = $1 AND user_id = $2 AND completed = true
         ORDER BY day_number DESC`,
        [req.params.missionId, req.user.userId]
      );
      const doneSet = new Set(streakRes.rows.map(r => r.day_number));
      for (let d = currentDay; d >= 1; d--) {
        if (doneSet.has(d)) myStreak++;
        else break;
      }
    }

    res.json({
      mission_id: mission.id,
      mode: mission.mode,
      scores: {
        [mission.user_name]:    scores[mission.user_id]    || 0,
        [mission.partner_name]: scores[mission.partner_id] || 0
      },
      leader: getLeader(mission, scores),
      my_streak: myStreak
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter placar.' });
  }
});

async function updateScore(mission, userId, executor) {
  const field = Number(mission.user_id) === Number(userId) ? 'user_score' : 'partner_score';
  await executor.query(`UPDATE missions SET ${field} = ${field} + 1 WHERE id = $1`, [mission.id]);
}

function checkinMessage(dayNumber, alreadyDone) {
  return alreadyDone ? `Dia ${dayNumber} já estava registado!` : `Dia ${dayNumber} registado! 🔥`;
}

// Trava a missão, calcula o dia e grava o check-in antes de soltar a trava.
// Vale para o dia comum e para o difícil. A cota difícil é por pessoa.
// Nota ao repetir o dia: sem frase nova, a nota que já existia fica (o dia
// difícil sem frase não apaga nada). Se o filtro de crise disparou
// (clearNote), a nota do dia é apagada, como no PR 12: nada de crise é
// gravado e nenhuma nota antiga volta a aparecer ao lado de um pedido de ajuda.
async function recordCheckin({ mission, userId, note, wantsDifficult, clearNote }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const lockedRes = await client.query(
      `SELECT id, user_id, partner_id, status, duration_days, started_at
       FROM missions
       WHERE id = $1
       FOR UPDATE`,
      [mission.id]
    );
    const locked = lockedRes.rows[0];
    const participates = locked && (
      sameId(locked.user_id, userId) || sameId(locked.partner_id, userId)
    );
    if (!participates) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'Missão não encontrada.' } };
    }
    if (locked.status !== 'active') {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'Missão não está ativa.' } };
    }

    const dayNumber = await missionDayNumber(locked, userId, client);
    if (!Number.isInteger(dayNumber) || dayNumber < 1) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'A missão ainda não começou.' } };
    }
    if (dayNumber > locked.duration_days) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'A missão já terminou.' } };
    }

    if (wantsDifficult) {
      const difficultRes = await client.query(
        `SELECT day_number
         FROM checkins
         WHERE mission_id = $1 AND user_id = $2 AND is_difficult = true
         FOR UPDATE`,
        [mission.id, userId]
      );
      const decision = validateDifficultDay({
        difficultDays: difficultRes.rows.map(row => row.day_number),
        dayNumber
      });
      if (!decision.ok) {
        await client.query('ROLLBACK');
        return { status: 400, body: { error: decision.error } };
      }
    }

    const existing = await client.query(
      `SELECT completed
       FROM checkins
       WHERE mission_id = $1 AND user_id = $2 AND day_number = $3
       FOR UPDATE`,
      [mission.id, userId, dayNumber]
    );
    const alreadyDone = existing.rows.length > 0 && existing.rows[0].completed === true;

    const checkinRes = await client.query(
      `INSERT INTO checkins (mission_id, user_id, day_number, completed, note, is_difficult)
       VALUES ($1, $2, $3, true, $4, $5)
       ON CONFLICT (mission_id, user_id, day_number)
       DO UPDATE SET completed = true,
                     note = CASE WHEN $6 THEN NULL ELSE COALESCE($4, checkins.note) END,
                     is_difficult = checkins.is_difficult OR EXCLUDED.is_difficult
       RETURNING *`,
      [mission.id, userId, dayNumber, note || null, wantsDifficult, clearNote === true]
    );

    if (!alreadyDone) {
      await updateScore(locked, userId, client);
    }
    await checkMissionCompletion({ ...mission, ...locked }, userId, client);
    await client.query('COMMIT');

    return {
      status: 201,
      body: {
        checkin: withDifficultFlag(checkinRes.rows[0]),
        day: dayNumber,
        already_done: alreadyDone,
        message: checkinMessage(dayNumber, alreadyDone)
      }
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A sessão pode já ter sido desfeita.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function streakSummary(mission, userId) {
  const todayDay = await missionDayNumber(mission, userId);
  const safeToday = Number.isInteger(todayDay) ? todayDay : 0;

  const result = await db.query(
    `SELECT day_number, completed, is_difficult
     FROM checkins
     WHERE mission_id = $1 AND user_id = $2
     ORDER BY day_number ASC`,
    [mission.id, userId]
  );

  const doneDays = new Set(
    result.rows.filter(row => row.completed === true).map(row => row.day_number)
  );
  const difficultDays = result.rows
    .filter(row => isDifficultDay(row))
    .map(row => row.day_number)
    .sort((left, right) => left - right);

  let streak = 0;
  for (let d = safeToday; d >= 1; d--) {
    if (doneDays.has(d)) streak++;
    else break;
  }

  const { brio, consistency, recovered } = calculateBrio(doneDays, Math.max(safeToday, 1), streak);
  const recovery = calculateRecoveryState(doneDays, safeToday);

  return {
    streak,
    total: doneDays.size,
    today_done: doneDays.has(safeToday),
    brio,
    consistency,
    recovered,
    ...recovery,
    difficult_days_used: difficultDays.length,
    difficult_days_remaining: Math.max(0, DIFFICULT_DAY_LIMIT - difficultDays.length),
    difficult_days: difficultDays
  };
}

// ============================================
// CALCULAR SEQUÊNCIA REAL
// GET /api/checkins/:missionId/streak
// ============================================
router.get('/:missionId/streak', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const missionRes = await db.query(
      `SELECT * FROM missions m
       WHERE id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [req.params.missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    res.json(await streakSummary(mission, userId));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao calcular sequência.' });
  }
});

async function checkMissionCompletion(mission, userId, db) {
  const pairRes = await db.query(
    `SELECT id FROM mission_matches
     WHERE status = 'active' AND (mission_a_id = $1 OR mission_b_id = $1)
     LIMIT 1`,
    [mission.id]
  );

  if (pairRes.rows[0] || !mission.partner_id || mission.user_id === userId) {
    const result = await db.query(
      `SELECT 1 FROM checkins
       WHERE mission_id = $1 AND user_id = $2 AND day_number >= $3 AND completed = true
       LIMIT 1`,
      [mission.id, userId, mission.duration_days]
    );
    if (result.rows[0]) {
      await db.query(`UPDATE missions SET status = 'completed' WHERE id = $1`, [mission.id]);
    }
    return;
  }

  const result = await db.query(
    `SELECT user_id FROM checkins WHERE mission_id = $1 AND day_number >= $2 AND completed = true`,
    [mission.id, mission.duration_days]
  );
  const ids = result.rows.map(r => r.user_id);
  if (ids.includes(mission.user_id) && ids.includes(mission.partner_id)) {
    await db.query(`UPDATE missions SET status = 'completed' WHERE id = $1`, [mission.id]);
  }
}

function getLeader(mission, scores) {
  const u = scores[mission.user_id] || 0;
  const p = scores[mission.partner_id] || 0;
  if (u > p) return mission.user_name;
  if (p > u) return mission.partner_name;
  return 'Empate!';
}

module.exports = router;


