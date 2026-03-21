// ============================================
// NEXUS — VÉRTICE
// Rota para disparar notificações contextuais
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const { generateNotification } = require('../vertice');
const { sendNotification }     = require('./notifications');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================
// OBTER MENSAGEM DO VÉRTICE PARA O UTILIZADOR
// GET /api/vertice/message
// Usado pelo dashboard para mostrar mensagem contextual
// ============================================
router.get('/message', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    // Buscar missão ativa ou em espera
    const missionRes = await db.query(
      `SELECT m.*, u.username AS partner_name
       FROM missions m
       LEFT JOIN users u ON (
         CASE WHEN m.user_id = $1 THEN m.partner_id ELSE m.user_id END = u.id
       )
       WHERE (m.user_id = $1 OR m.partner_id = $1)
         AND m.status IN ('active', 'waiting')
       ORDER BY m.created_at DESC LIMIT 1`,
      [userId]
    );

    const mission = missionRes.rows[0];

    if (!mission) {
      return res.json({ message: "Sem missão ativa." });
    }

    const isWaiting = mission.status === 'waiting';

    if (isWaiting) {
      const { body } = generateNotification({ mode: 'solo', dayNumber: 0, isWaiting: true });
      return res.json({ message: body });
    }

    // Calcular dia atual
    const started   = new Date(mission.started_at);
    const today     = new Date();
    const dayNumber = Math.floor((today - started) / (1000 * 60 * 60 * 24)) + 1;

    // Check-ins de hoje
    const todayStr = today.toISOString().split('T')[0];

    const userCheckinRes = await db.query(
      `SELECT * FROM checkins WHERE mission_id = $1 AND user_id = $2 AND day_number = $3`,
      [mission.id, userId, dayNumber]
    );
    const userDoneToday = userCheckinRes.rows.length > 0 && userCheckinRes.rows[0].completed;

    let rivalDoneToday   = false;
    let partnerDoneToday = false;

    if (mission.partner_id) {
      const partnerId = mission.user_id === userId ? mission.partner_id : mission.user_id;
      const partnerCheckinRes = await db.query(
        `SELECT * FROM checkins WHERE mission_id = $1 AND user_id = $2 AND day_number = $3`,
        [mission.id, partnerId, dayNumber]
      );
      const partnerDone = partnerCheckinRes.rows.length > 0 && partnerCheckinRes.rows[0].completed;
      rivalDoneToday   = mission.mode === 'rival'    ? partnerDone : false;
      partnerDoneToday = mission.mode === 'parceiro' ? partnerDone : false;
    }

    // Calcular streak
    const streakRes = await db.query(
      `SELECT COUNT(*) as streak FROM checkins
       WHERE mission_id = $1 AND user_id = $2
         AND completed = true AND day_number >= $3`,
      [mission.id, userId, Math.max(1, dayNumber - 6)]
    );
    const streak = parseInt(streakRes.rows[0].streak);

    // Scores — ler direto da tabela checkins (fonte da verdade)
    const scoresRes = await db.query(
      `SELECT user_id, COUNT(*) as days FROM checkins
       WHERE mission_id = $1 AND completed = true GROUP BY user_id`,
      [mission.id]
    );
    const scoresMap = scoresRes.rows.reduce((acc, r) => {
      acc[r.user_id] = parseInt(r.days);
      return acc;
    }, {});
    const isUser       = mission.user_id === userId;
    const partnerId    = isUser ? mission.partner_id : mission.user_id;
    const userScore    = scoresMap[userId]    || 0;
    const partnerScore = scoresMap[partnerId] || 0;

    const context = {
      mode: mission.mode,
      dayNumber,
      streak,
      userScore,
      partnerScore,
      rivalDoneToday,
      partnerDoneToday,
      userDoneToday,
      isWaiting: false
    };

    const { body } = generateNotification(context);

    res.json({
      message: body,
      day: dayNumber,
      mode: mission.mode,
      user_done: userDoneToday
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao gerar mensagem.' });
  }
});

// ============================================
// DISPARAR NOTIFICAÇÕES PARA TODOS
// POST /api/vertice/notify-all
// (Chamado por um cron job ou manualmente)
// ============================================
router.post('/notify-all', async (req, res) => {
  // Chave secreta para proteger este endpoint (VERTICE_SECRET, separado do JWT)
  const secret = req.headers['x-vertice-secret'];
  const expected = process.env.VERTICE_SECRET || process.env.JWT_SECRET;
  if (secret !== expected) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    // Buscar todas as missões ativas
    const missionsRes = await db.query(
      `SELECT m.*, u1.id AS uid1, u2.id AS uid2
       FROM missions m
       JOIN users u1 ON m.user_id = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.status IN ('active', 'waiting')`
    );

    let sent = 0;

    for (const mission of missionsRes.rows) {
      const usersToNotify = [mission.user_id];
      if (mission.partner_id) usersToNotify.push(mission.partner_id);

      for (const userId of usersToNotify) {
        const started   = new Date(mission.started_at || Date.now());
        const dayNumber = Math.floor((Date.now() - started) / (1000 * 60 * 60 * 24)) + 1;

        const checkinRes = await db.query(
          `SELECT * FROM checkins WHERE mission_id = $1 AND user_id = $2 AND day_number = $3`,
          [mission.id, userId, dayNumber]
        );
        const userDoneToday = checkinRes.rows.length > 0;

        const context = {
          mode: mission.status === 'waiting' ? 'solo' : mission.mode,
          dayNumber,
          streak: 0,
          userScore: 0,
          partnerScore: 0,
          rivalDoneToday: false,
          partnerDoneToday: false,
          userDoneToday,
          isWaiting: mission.status === 'waiting'
        };

        const { title, body } = generateNotification(context);
        await sendNotification(userId, title, body);
        sent++;
      }
    }

    res.json({ success: true, notifications_sent: sent });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao enviar notificações.' });
  }
});

module.exports = router;
