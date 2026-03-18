// ============================================
// NEXUS — Rotas de Check-ins
// Registo diário de progresso + pontuação
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================
// FAZER CHECK-IN DO DIA
// POST /api/checkins
// Body: { mission_id, note }
// ============================================
router.post('/', auth, async (req, res) => {
  const { mission_id, note } = req.body;
  const userId = req.user.userId;

  if (!mission_id) {
    return res.status(400).json({ error: 'mission_id é obrigatório.' });
  }

  try {
    // Buscar a missão e verificar que o utilizador faz parte dela
    const missionRes = await db.query(
      `SELECT * FROM missions WHERE id = $1 AND (user_id = $2 OR partner_id = $2)`,
      [mission_id, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) {
      return res.status(404).json({ error: 'Missão não encontrada ou sem acesso.' });
    }
    if (mission.status !== 'active') {
      return res.status(400).json({ error: 'A missão não está ativa.' });
    }

    // Calcular em que dia da missão estamos
    const started  = new Date(mission.started_at);
    const today    = new Date();
    const dayNumber = Math.floor((today - started) / (1000 * 60 * 60 * 24)) + 1;

    if (dayNumber > mission.duration_days) {
      return res.status(400).json({ error: 'A missão já terminou.' });
    }

    // Registar o check-in (UNIQUE garante só 1 por dia)
    const checkinRes = await db.query(
      `INSERT INTO checkins (mission_id, user_id, day_number, completed, note)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (mission_id, user_id, day_number)
       DO UPDATE SET completed = true, note = $4
       RETURNING *`,
      [mission_id, userId, dayNumber, note || null]
    );

    // Atualizar pontuação na missão (modo rival ou parceiro)
    await updateScore(mission, userId, db);

    // Verificar se a missão foi completada (dia 30 feito por ambos)
    await checkMissionCompletion(mission, db);

    res.status(201).json({
      checkin: checkinRes.rows[0],
      day: dayNumber,
      message: `Dia ${dayNumber} registado! 🔥`
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao registar check-in.' });
  }
});

// ============================================
// VER PROGRESSO DE UMA MISSÃO
// GET /api/checkins/:missionId
// ============================================
router.get('/:missionId', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         c.*,
         u.username
       FROM checkins c
       JOIN users u ON c.user_id = u.id
       WHERE c.mission_id = $1
       ORDER BY c.day_number ASC, c.created_at ASC`,
      [req.params.missionId]
    );

    // Organizar por utilizador para o frontend mostrar
    // o progresso lado a lado (tu vs rival)
    const byUser = result.rows.reduce((acc, row) => {
      if (!acc[row.user_id]) {
        acc[row.user_id] = { username: row.username, checkins: [] };
      }
      acc[row.user_id].checkins.push({
        day: row.day_number,
        completed: row.completed,
        note: row.note,
        date: row.created_at
      });
      return acc;
    }, {});

    res.json({ progress: byUser });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter progresso.' });
  }
});

// ============================================
// VER PLACAR (MODO RIVAL)
// GET /api/checkins/:missionId/score
// ============================================
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

    // Contar dias completados por cada um
    const scoresRes = await db.query(
      `SELECT user_id, COUNT(*) as days_completed
       FROM checkins
       WHERE mission_id = $1 AND completed = true
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
      duration: mission.duration_days,
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
// FUNÇÕES AUXILIARES
// ============================================

// Atualiza a pontuação acumulada na tabela missions
async function updateScore(mission, userId, db) {
  const field = mission.user_id === userId ? 'user_score' : 'partner_score';
  await db.query(
    `UPDATE missions SET ${field} = ${field} + 1 WHERE id = $1`,
    [mission.id]
  );
}

// Verifica se ambos completaram o dia 30 e encerra a missão
async function checkMissionCompletion(mission, db) {
  if (!mission.partner_id) return;

  const result = await db.query(
    `SELECT user_id FROM checkins
     WHERE mission_id = $1
       AND day_number = $2
       AND completed  = true`,
    [mission.id, mission.duration_days]
  );

  // Se ambos fizeram o último check-in, missão completa
  const completedUsers = result.rows.map(r => r.user_id);
  const bothDone = completedUsers.includes(mission.user_id) &&
                   completedUsers.includes(mission.partner_id);

  if (bothDone) {
    await db.query(
      `UPDATE missions SET status = 'completed' WHERE id = $1`,
      [mission.id]
    );
    // Aqui no futuro: enviar notificação "Porta Aberta desbloqueada!"
  }
}

// Devolve o nome de quem está a liderar
function getLeader(mission, scores) {
  const userScore    = scores[mission.user_id]    || 0;
  const partnerScore = scores[mission.partner_id] || 0;
  if (userScore > partnerScore) return mission.user_name;
  if (partnerScore > userScore) return mission.partner_name;
  return 'Empate!';
}

module.exports = router;
