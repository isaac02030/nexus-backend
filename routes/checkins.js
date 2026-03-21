// ============================================
// NEXUS — Rotas de Check-ins
// Registo diário de progresso + pontuação
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

router.post('/', auth, async (req, res) => {
  const { mission_id, note } = req.body;
  const userId = req.user.userId;

  if (!mission_id) {
    return res.status(400).json({ error: 'mission_id é obrigatório.' });
  }

  try {
    const missionRes = await db.query(
      `SELECT * FROM missions WHERE id = $1 AND (user_id = $2 OR partner_id = $2)`,
      [mission_id, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });
    if (mission.status !== 'active') return res.status(400).json({ error: 'Missão não está ativa.' });

    const started   = new Date(mission.started_at);
    const today     = new Date();
    const dayNumber = Math.floor((today - started) / (1000 * 60 * 60 * 24)) + 1;

    if (dayNumber > mission.duration_days) {
      return res.status(400).json({ error: 'A missão já terminou.' });
    }

    // Verificar se já fez check-in hoje
    const existing = await db.query(
      `SELECT * FROM checkins WHERE mission_id = $1 AND user_id = $2 AND day_number = $3`,
      [mission_id, userId, dayNumber]
    );
    const alreadyDone = existing.rows.length > 0 && existing.rows[0].completed === true;

    // Registar o check-in
    const checkinRes = await db.query(
      `INSERT INTO checkins (mission_id, user_id, day_number, completed, note)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (mission_id, user_id, day_number)
       DO UPDATE SET completed = true, note = $4
       RETURNING *`,
      [mission_id, userId, dayNumber, note || null]
    );

    // Só incrementar pontuação se for a primeira vez hoje
    if (!alreadyDone) {
      await updateScore(mission, userId, db);
    }

    await checkMissionCompletion(mission, db);

    res.status(201).json({
      checkin: checkinRes.rows[0],
      day: dayNumber,
      already_done: alreadyDone,
      message: alreadyDone ? `Dia ${dayNumber} já estava registado!` : `Dia ${dayNumber} registado! 🔥`
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao registar check-in.' });
  }
});

router.get('/:missionId', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*, u.username FROM checkins c
       JOIN users u ON c.user_id = u.id
       WHERE c.mission_id = $1
       ORDER BY c.day_number ASC`,
      [req.params.missionId]
    );

    const byUser = result.rows.reduce((acc, row) => {
      if (!acc[row.user_id]) acc[row.user_id] = { username: row.username, checkins: [] };
      acc[row.user_id].checkins.push({ day: row.day_number, completed: row.completed, note: row.note });
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
       WHERE m.id = $1`,
      [req.params.missionId]
    );

    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    // Contar direto da tabela checkins (mais fiável)
    const scoresRes = await db.query(
      `SELECT user_id, COUNT(*) as days_completed
       FROM checkins WHERE mission_id = $1 AND completed = true
       GROUP BY user_id`,
      [req.params.missionId]
    );

    const scores = scoresRes.rows.reduce((acc, row) => {
      acc[row.user_id] = parseInt(row.days_completed);
      return acc;
    }, {});

    res.json({
      mission_id: mission.id,
      mode: mission.mode,
      scores: {
        [mission.user_name]:    scores[mission.user_id]    || 0,
        [mission.partner_name]: scores[mission.partner_id] || 0
      },
      leader: getLeader(mission, scores)
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter placar.' });
  }
});

// ============================================
// CALCULAR SEQUÊNCIA REAL
// GET /api/checkins/:missionId/streak
// ============================================
router.get('/:missionId/streak', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const missionRes = await db.query(
      'SELECT * FROM missions WHERE id = $1 AND (user_id = $2 OR partner_id = $2)',
      [req.params.missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    const started   = new Date(mission.started_at);
    const today     = new Date();
    const todayDay  = Math.floor((today - started) / (1000 * 60 * 60 * 24)) + 1;

    // Buscar todos os check-ins do utilizador nesta missão
    const result = await db.query(
      `SELECT day_number FROM checkins
       WHERE mission_id = $1 AND user_id = $2 AND completed = true
       ORDER BY day_number DESC`,
      [mission.id, userId]
    );

    const doneDays = new Set(result.rows.map(r => r.day_number));

    // Calcular sequência a partir de hoje para trás
    let streak = 0;
    for (let d = todayDay; d >= 1; d--) {
      if (doneDays.has(d)) {
        streak++;
      } else {
        break;
      }
    }

    // Total de dias completados
    const total = doneDays.size;

    res.json({ streak, total, today_done: doneDays.has(todayDay) });
  } catch(err) {
    res.status(500).json({ error: 'Erro ao calcular sequência.' });
  }
});

async function updateScore(mission, userId, db) {
  const field = mission.user_id === userId ? 'user_score' : 'partner_score';
  await db.query(`UPDATE missions SET ${field} = ${field} + 1 WHERE id = $1`, [mission.id]);
}

// ============================================
// SEQUÊNCIA REAL
// GET /api/checkins/:missionId/streak
// ============================================
router.get('/:missionId/streak', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const missionRes = await db.query(
      'SELECT * FROM missions WHERE id = $1 AND (user_id = $2 OR partner_id = $2)',
      [req.params.missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    const started  = new Date(mission.started_at);
    const today    = new Date();
    const todayDay = Math.floor((today - started) / (1000 * 60 * 60 * 24)) + 1;

    const result = await db.query(
      `SELECT day_number FROM checkins
       WHERE mission_id = $1 AND user_id = $2 AND completed = true
       ORDER BY day_number DESC`,
      [mission.id, userId]
    );

    const doneDays = new Set(result.rows.map(r => r.day_number));

    // Calcular sequência consecutiva a partir de hoje para trás
    let streak = 0;
    for (let d = todayDay; d >= 1; d--) {
      if (doneDays.has(d)) streak++;
      else break;
    }

    res.json({ streak, total: doneDays.size, today_done: doneDays.has(todayDay) });
  } catch(err) {
    res.status(500).json({ error: 'Erro ao calcular sequência.' });
  }
});

async function checkMissionCompletion(mission, db) {
  if (!mission.partner_id) return;
  const result = await db.query(
    `SELECT user_id FROM checkins WHERE mission_id = $1 AND day_number = $2 AND completed = true`,
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
