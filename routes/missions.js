// ============================================
// NEXUS - Rotas de Missoes
// Criar, ver e fazer match
// ============================================

const express = require('express');
const { db } = require('../lib/db');
const auth = require('../middleware/auth');
const { validateMissionWeekdays } = require('../lib/mission-days');
const { parseArea, parseSubject } = require('../lib/community-access');
const { classifyNote } = require('../lib/crisis-filter');

// O assunto (PR 40) é texto livre que fica no banco: passa pelo filtro de
// crise antes de tudo. Com alerta, a missão não é criada (texto para o sim
// do dono do projeto).
const MISSION_CRISIS_MESSAGE = 'A missão não foi criada. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const router = express.Router();

let missionParticipantHealingReady = false;

// Auto-matching stays off unless the environment explicitly sets MATCHING_ENABLED=true.
function isMatchingEnabled() {
  return String(process.env.MATCHING_ENABLED || '').toLowerCase() === 'true';
}

function missionParticipantWhere(alias = 'm', userParam = '$1') {
  return `(
    ${alias}.user_id = ${userParam}
    OR ${alias}.partner_id = ${userParam}
  )`;
}

async function healPairedMissionParticipants() {
  if (missionParticipantHealingReady) return;

  await db.query(`
    WITH participant_history AS (
      SELECT mission_id, user_id
      FROM checkins
      GROUP BY mission_id, user_id

      UNION

      SELECT mission_id, sender_id AS user_id
      FROM messages
      GROUP BY mission_id, sender_id
    ),
    recoverable AS (
      SELECT
        m.id AS mission_id,
        MIN(ph.user_id) AS recovered_user_id,
        COUNT(DISTINCT ph.user_id) AS recovered_count
      FROM missions m
      JOIN participant_history ph
        ON ph.mission_id = m.id
      WHERE m.partner_id IS NULL
        AND m.mode IN ('parceiro', 'rival')
        AND ph.user_id <> m.user_id
      GROUP BY m.id
    )
    UPDATE missions m
    SET partner_id = r.recovered_user_id,
        -- Parceiro que entra sempre tem início de par (a conversa só mostra
        -- o que veio depois dele; sem início, a conversa fica vazia).
        pair_started_at = COALESCE(m.pair_started_at, NOW())
    FROM recoverable r
    WHERE m.id = r.mission_id
      AND r.recovered_count = 1
  `);

  missionParticipantHealingReady = true;
}

async function healWaitingSoloMissions() {
  await db.query(`
    UPDATE missions
    SET status = 'active',
        started_at = COALESCE(started_at, created_at, NOW()),
        ends_at = COALESCE(ends_at, COALESCE(started_at, created_at, NOW()) + INTERVAL '30 days')
    WHERE mode = 'solo'
      AND status = 'waiting'
  `);

  await db.query(`
    UPDATE missions
    SET match_preference = COALESCE(match_preference, mode),
        mode = 'solo',
        status = 'active',
        started_at = COALESCE(started_at, created_at, NOW()),
        ends_at = COALESCE(ends_at, COALESCE(started_at, created_at, NOW()) + INTERVAL '30 days')
    WHERE status = 'waiting'
      AND mode IN ('parceiro', 'rival')
      AND partner_id IS NULL
  `);
}

// Encerra o par por mission_matches dentro de uma transação JÁ ABERTA pelo
// chamador (o bloqueio do chat usa esta parte para gravar o bloqueio e o fim
// do par juntos). Devolve false se não há par ativo.
async function endMatchInTransaction(client, missionId, userId, { abandon = false } = {}) {
  const pairRes = await client.query(
    `SELECT mm.*, ma.user_id AS user_a, mb.user_id AS user_b,
            ma.id AS mission_a, mb.id AS mission_b
     FROM mission_matches mm
     JOIN missions ma ON ma.id = mm.mission_a_id
     JOIN missions mb ON mb.id = mm.mission_b_id
     WHERE mm.status = 'active'
       AND (mm.mission_a_id = $1 OR mm.mission_b_id = $1)
       AND (ma.user_id = $2 OR mb.user_id = $2)
     LIMIT 1
     FOR UPDATE OF mm`,
    [missionId, userId]
  );
  const pair = pairRes.rows[0];
  if (!pair) return false;

  const isMissionAOwner = Number(pair.user_a) === Number(userId);
  const ownedMissionId = isMissionAOwner ? pair.mission_a : pair.mission_b;
  const counterpartMissionId = isMissionAOwner ? pair.mission_b : pair.mission_a;
  await client.query(
    `UPDATE missions
     SET mode = 'solo', partner_id = NULL, match_preference = NULL, pair_started_at = NULL,
         status = CASE WHEN id = $1 AND $3 THEN 'abandoned' ELSE status END,
         ends_at = CASE WHEN id = $1 AND $3 THEN NOW() ELSE ends_at END
     WHERE id IN ($1, $2)`,
    [ownedMissionId, counterpartMissionId, abandon]
  );
  await client.query(
    `UPDATE mission_matches SET status = 'ended', ended_at = NOW() WHERE id = $1`,
    [pair.id]
  );
  return true;
}

async function endLinkedMissionMatch(missionId, userId, { abandon = false } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ended = await endMatchInTransaction(client, missionId, userId, { abandon });
    await client.query('COMMIT');
    return ended;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/', auth, async (req, res) => {
  const {
    title,
    category,
    level,
    mode,
    description,
    daily_minimum,
    commitment_window,
    why_it_matters,
    fallback_plan,
    proof_mode,
    study_focus,
    study_current_stage,
    study_target_outcome,
    mission_weekdays,
    area,
    subject
  } = req.body;
  const userId = req.user.userId;

  const subjectCrisis = typeof subject === 'string' ? classifyNote(subject) : null;
  if (subjectCrisis) {
    return res.status(200).json({
      saved: false,
      crisis: true,
      crisis_level: subjectCrisis,
      message: MISSION_CRISIS_MESSAGE
    });
  }

  if (!title || !category) {
    return res.status(400).json({ error: 'Titulo e categoria sao obrigatorios.' });
  }

  // Dias da missão (1 = segunda ... 7 = domingo), de 3 a 7 por semana.
  // Sem o campo, valem todos os dias, como antes.
  const weekdays = validateMissionWeekdays(mission_weekdays);
  if (!weekdays.ok) {
    return res.status(400).json({ error: weekdays.error });
  }

  // Área (mente, corpo ou rotina) e assunto (migração 013). Opcionais por
  // enquanto: sem eles, a missão é criada como antes (sem área, lê a
  // comunidade mas não posta). Com eles, só valores válidos.
  const areaChoice = parseArea(area);
  if (!areaChoice.ok) {
    return res.status(400).json({ error: areaChoice.error, code: 'invalid_area' });
  }
  const subjectChoice = parseSubject(subject);
  if (!subjectChoice.ok) {
    return res.status(400).json({ error: subjectChoice.error, code: 'invalid_subject' });
  }

  try {
    await healPairedMissionParticipants();
    await healWaitingSoloMissions();

    const requestedMode = ['parceiro', 'rival'].includes(mode) ? mode : 'solo';
    // A coluna mission_weekdays vem da migração 004. Só entra no INSERT
    // quando a pessoa escolheu os dias; sem escolha, o INSERT fica igual
    // ao de antes e funciona mesmo sem a migração aplicada.
    const withWeekdays = weekdays.value !== null;
    // Mesma ideia para a área e o assunto (migração 013): só entram no INSERT
    // quando vieram no pedido.
    const extraColumns = [];
    const extraValues = [];
    const extraParams = [];
    if (withWeekdays) {
      extraColumns.push('mission_weekdays');
      extraParams.push(weekdays.value);
      extraValues.push(`$${14 + extraParams.length}::smallint[]`);
    }
    const withArea = areaChoice.value !== null || subjectChoice.value !== null;
    if (areaChoice.value !== null) {
      extraColumns.push('area');
      extraParams.push(areaChoice.value);
      extraValues.push(`$${14 + extraParams.length}`);
    }
    if (subjectChoice.value !== null) {
      extraColumns.push('subject');
      extraParams.push(subjectChoice.value);
      extraValues.push(`$${14 + extraParams.length}`);
    }
    const result = await db.query(
      `INSERT INTO missions (
         user_id, title, category, level, mode, match_preference, description,
         daily_minimum, commitment_window, why_it_matters, fallback_plan, proof_mode,
         study_focus, study_current_stage, study_target_outcome${extraColumns.map((c) => `, ${c}`).join('')}
       )
       VALUES ($1, $2, $3, $4, 'solo', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14${extraValues.map((v) => `, ${v}`).join('')})
       RETURNING *`,
      [
        userId,
        title,
        category,
        level || 'iniciante',
        requestedMode === 'solo' ? null : requestedMode,
        description || null,
        daily_minimum || null,
        commitment_window || null,
        why_it_matters || null,
        fallback_plan || null,
        proof_mode || 'self_report',
        study_focus || null,
        study_current_stage || null,
        study_target_outcome || null,
        ...extraParams
      ]
    ).catch((err) => {
      // 42703 = coluna não existe: a migração 004 (dias) ou a 013 (área)
      // ainda não foi aplicada. O INSERT falhou inteiro, então nada foi criado.
      // A mensagem do Postgres diz qual coluna faltou.
      if (err && err.code === '42703') {
        const areaColumn = /"(area|subject)"/.test(String(err.message || ''));
        if (withArea && (areaColumn || !withWeekdays)) err.missionAreaMissing = true;
        else if (withWeekdays) err.missionWeekdaysMissing = true;
      }
      throw err;
    });

    const now = new Date();
    const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const activated = await db.query(
      `UPDATE missions
       SET status = 'active', started_at = $1, ends_at = $2
       WHERE id = $3
       RETURNING *`,
      [now, endsAt, result.rows[0].id]
    );

    let mission = activated.rows[0];
    const matchingEnabled = isMatchingEnabled();
    const match = matchingEnabled && mission.match_preference
      ? await tryMatchMission(mission, userId, db)
      : null;
    if (match) mission = match.currentMission;

    return res.status(201).json({
      mission,
      matched: !!match,
      matchedWith: match ? match.partnerMission.user_id : null,
      matchingEnabled,
      message: match
        ? 'Par encontrado. A tua missão continua com o progresso atual.'
        : matchingEnabled && mission.match_preference
          ? 'A missão começou em solo. Vamos procurar alguém compatível enquanto segues.'
          : 'Missao solo criada.'
    });
  } catch (err) {
    if (err && err.missionAreaMissing === true) {
      return res.status(503).json({
        error: 'A escolha da área da missão ainda não está disponível. Crie a missão sem escolher a área ou tente mais tarde.',
        code: 'area_unavailable'
      });
    }
    if (err && err.missionWeekdaysMissing === true) {
      return res.status(503).json({
        error: 'A escolha dos dias da missão ainda não está disponível. Crie a missão sem escolher os dias ou tente mais tarde.'
      });
    }
    res.status(500).json({ error: 'Erro ao criar missao.' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    await healPairedMissionParticipants();
    await healWaitingSoloMissions();

    const result = await db.query(
      `SELECT m.*,
              u1.username AS user_name,
              u2.username AS partner_name
       FROM missions m
       LEFT JOIN users u1 ON m.user_id = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [req.params.id, req.user.userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Missao nao encontrada.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter missao.' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    await healPairedMissionParticipants();
    await healWaitingSoloMissions();

    const result = await db.query(
      `SELECT m.*,
        u2.username AS partner_name,
        COALESCE(counterpart.user_id, m.partner_id) AS counterpart_user_id,
        counterpart.id AS partner_mission_id,
        pair.started_at AS match_started_at,
        COALESCE(counterpart.started_at, m.partner_started_at, m.started_at) AS partner_started_at,
        CASE WHEN pair.id IS NOT NULL THEN (
          SELECT COUNT(*) FROM checkins own_checkin
          WHERE own_checkin.mission_id = m.id
            AND own_checkin.user_id = m.user_id
            AND own_checkin.completed = true
            AND own_checkin.created_at >= pair.started_at
        ) ELSE m.user_score END AS user_score,
        CASE WHEN pair.id IS NOT NULL THEN (
          SELECT COUNT(*) FROM checkins partner_checkin
          WHERE partner_checkin.mission_id = counterpart.id
            AND partner_checkin.user_id = counterpart.user_id
            AND partner_checkin.completed = true
            AND partner_checkin.created_at >= pair.started_at
        ) ELSE m.partner_score END AS partner_score,
        (
          SELECT MAX(c.day_number)
          FROM checkins c
          WHERE c.mission_id = COALESCE(counterpart.id, m.id)
            AND c.completed = true
            AND c.user_id = COALESCE(counterpart.user_id, m.partner_id)
       ) AS partner_last_checkin_day,
       (SELECT MAX(c.created_at)
        FROM checkins c
        WHERE c.mission_id = COALESCE(counterpart.id, m.id)
          AND c.user_id = COALESCE(counterpart.user_id, m.partner_id)
          AND c.completed = true) AS partner_last_checkin_at
       FROM missions m
       LEFT JOIN mission_matches pair
         ON pair.status = 'active' AND (pair.mission_a_id = m.id OR pair.mission_b_id = m.id)
       LEFT JOIN missions counterpart
         ON counterpart.id = CASE
           WHEN pair.mission_a_id = m.id THEN pair.mission_b_id
           WHEN pair.mission_b_id = m.id THEN pair.mission_a_id
           ELSE NULL
         END
       LEFT JOIN users u1 ON m.user_id = u1.id
       LEFT JOIN users u2 ON u2.id = COALESCE(counterpart.user_id, m.partner_id)
       WHERE (
         m.user_id = $1
         OR (m.partner_id = $1 AND pair.id IS NULL)
       ) AND m.status <> 'merged'
       ORDER BY m.created_at DESC`,
      [req.user.userId]
    );

    res.json(result.rows.map(mission => ({
      ...mission,
      matching_enabled: isMatchingEnabled()
    })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar missoes.' });
  }
});

router.post('/:id/match', auth, async (req, res) => {
  try {
    const missionRes = await db.query(
      `SELECT * FROM missions
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       LIMIT 1`,
      [req.params.id, req.user.userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão ativa não encontrada.' });
    if (!isMatchingEnabled()) {
      return res.json({ matched: false, matchingEnabled: false, mission });
    }
    if (!mission.match_preference) return res.json({ matched: false, mission });

    const match = await tryMatchMission(mission, req.user.userId, db);
    if (!match) return res.json({ matched: false, mission });
    res.json({ matched: true, matchingEnabled: true, mission: match.currentMission, matchedWith: match.partnerMission.user_id });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao procurar um par compatível.' });
  }
});

router.delete('/:id/waiting', auth, async (req, res) => {
  const missionId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `DELETE FROM missions
       WHERE id = $1 AND user_id = $2 AND status = 'waiting'
       RETURNING id`,
      [missionId, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Missao em espera nao encontrada.' });
    }

    res.json({ success: true, message: 'Saíste da fila de espera.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sair da fila.' });
  }
});

router.post('/:id/abandon', auth, async (req, res) => {
  const missionId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `SELECT *
       FROM missions
       WHERE id = $1
         AND status = 'active'
         AND (user_id = $2 OR partner_id = $2)
       LIMIT 1`,
      [missionId, userId]
    );

    const mission = result.rows[0];

    if (!mission) {
      return res.status(404).json({ error: 'Missao ativa nao encontrada.' });
    }

    if (await endLinkedMissionMatch(missionId, userId, { abandon: true })) {
      return res.json({ success: true, message: 'Saíste da missão. A outra pessoa continua em solo.' });
    }

    if (!mission.partner_id || mission.mode === 'solo') {
      if (mission.user_id !== userId) {
        return res.status(403).json({ error: 'Nao autorizado para encerrar esta missao.' });
      }

      await db.query(
        `UPDATE missions
         SET status = 'abandoned',
             ends_at = NOW()
         WHERE id = $1`,
        [missionId]
      );

      return res.json({
        success: true,
        message: 'Missao solo encerrada.'
      });
    }

    if (mission.partner_id === userId) {
      await db.query(
        `UPDATE missions
         SET partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId]
      );
    } else {
      await db.query(
        `UPDATE missions
         SET user_id = partner_id,
             partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId]
      );
    }

    res.json({
      success: true,
      message: 'Saíste da missão. A outra pessoa continua em solo.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sair da missao.' });
  }
});

router.post('/:id/continue-solo', auth, async (req, res) => {
  const missionId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `SELECT *
       FROM missions
       WHERE id = $1
         AND status = 'active'
         AND (user_id = $2 OR partner_id = $2)
       LIMIT 1`,
      [missionId, userId]
    );

    const mission = result.rows[0];

    if (!mission) {
      return res.status(404).json({ error: 'Missao ativa nao encontrada.' });
    }

    if (await endLinkedMissionMatch(missionId, userId)) {
      return res.json({
        success: true,
        message: 'A missão agora continua em solo, sem perder o teu progresso.'
      });
    }

    if (!mission.partner_id || mission.mode === 'solo') {
      return res.status(400).json({ error: 'Esta missao ja esta em solo.' });
    }

    if (mission.user_id === userId) {
      await db.query(
        `UPDATE missions
         SET partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId]
      );
    } else {
      await db.query(
        `UPDATE missions
         SET user_id = $2,
             partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId, userId]
      );
    }

    res.json({
      success: true,
      message: 'A missão agora continua em solo, sem perder o teu progresso.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao continuar em solo.' });
  }
});

function missionLevelRank(level) {
  const normalized = String(level || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (normalized === 'iniciante') return 1;
  if (normalized === 'intermedio' || normalized === 'intermediario') return 2;
  if (normalized === 'avancado') return 3;
  return null;
}

async function tryMatchMission(currentMission, currentUserId, pool) {
  const requestedMode = currentMission.match_preference;
  const currentRank = missionLevelRank(currentMission.level);
  if (!['parceiro', 'rival'].includes(requestedMode) || !currentRank) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedCurrentRes = await client.query(
      `SELECT * FROM missions
       WHERE id = $1 AND user_id = $2 AND status = 'active'
         AND mode = 'solo' AND partner_id IS NULL
       FOR UPDATE`,
      [currentMission.id, currentUserId]
    );
    const lockedCurrent = lockedCurrentRes.rows[0];
    if (!lockedCurrent || lockedCurrent.match_preference !== requestedMode) {
      await client.query('COMMIT');
      return null;
    }

    // Bloqueio do chat (migração 011): quem bloqueou ou foi bloqueado nunca
    // vira par de novo. Antes da 011 a tabela não existe e não há bloqueio.
    const blocksRes = await client.query(
      "SELECT to_regclass('public.user_blocks') IS NOT NULL AS ready"
    );
    const blockClause = blocksRes.rows[0] && blocksRes.rows[0].ready === true
      ? `AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $3 AND b.blocked_id = m.user_id)
              OR (b.blocker_id = m.user_id AND b.blocked_id = $3)
         )`
      : '';

    const candidateRes = await client.query(
      `SELECT m.*
       FROM missions m
       WHERE m.status = 'active'
         AND m.mode = 'solo'
         AND m.match_preference = $1
         AND LOWER(BTRIM(m.category)) = LOWER(BTRIM($2))
         AND m.user_id <> $3
         AND m.partner_id IS NULL
         ${blockClause}
         AND NOT EXISTS (
           SELECT 1 FROM mission_matches mm
           WHERE mm.status = 'active'
             AND (mm.mission_a_id = m.id OR mm.mission_b_id = m.id)
         )
         AND CASE
           WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'iniciante' THEN 1
           WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) IN ('intermedio', 'intermediario') THEN 2
           WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'avancado' THEN 3
           ELSE NULL
         END BETWEEN GREATEST(1, $4 - 1) AND LEAST(3, $4 + 1)
       ORDER BY CASE
           WHEN CASE
             WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'iniciante' THEN 1
             WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) IN ('intermedio', 'intermediario') THEN 2
             WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'avancado' THEN 3
             ELSE NULL
           END = $4 THEN 0 ELSE 1 END,
         m.created_at ASC
       LIMIT 1
       FOR UPDATE OF m SKIP LOCKED`,
      [requestedMode, lockedCurrent.category, currentUserId, currentRank]
    );
    const candidate = candidateRes.rows[0];
    if (!candidate) {
      await client.query('COMMIT');
      return null;
    }

    // Início do par com o relógio do banco (NOW(), o mesmo de
    // messages.created_at), nunca com o do Node: um TIMESTAMP sem fuso gravado
    // a partir de um Date do Node pode ficar horas à frente e esconder as
    // primeiras mensagens do par (revisão do Argos no PR 35). Na mesma
    // transação, NOW() é o mesmo instante nas três linhas.
    const matchRes = await client.query(
      `INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, started_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING started_at`,
      [lockedCurrent.id, candidate.id, requestedMode]
    );
    const now = matchRes.rows[0] ? matchRes.rows[0].started_at : null;
    await client.query(
      `UPDATE missions
       SET mode = $1, partner_id = $2, pair_started_at = NOW()
       WHERE id = $3`,
      [requestedMode, candidate.user_id, lockedCurrent.id]
    );
    await client.query(
      `UPDATE missions
       SET mode = $1, partner_id = $2, pair_started_at = NOW()
       WHERE id = $3`,
      [requestedMode, currentUserId, candidate.id]
    );
    await client.query('COMMIT');

    return {
      currentMission: { ...lockedCurrent, mode: requestedMode, partner_id: candidate.user_id, pair_started_at: now },
      partnerMission: candidate
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
// Usadas pelo bloqueio do chat (routes/messages.js) e pelos testes.
module.exports.endLinkedMissionMatch = endLinkedMissionMatch;
module.exports.endMatchInTransaction = endMatchInTransaction;
module.exports.tryMatchMission = tryMatchMission;
