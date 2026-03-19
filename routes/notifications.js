// ============================================
// NEXUS — Push Notifications
// Web Push API com VAPID
// ============================================

const express   = require('express');
const webpush   = require('web-push');
const { Pool }  = require('pg');
const auth      = require('../middleware/auth');
const router    = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Configurar VAPID
webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============================================
// OBTER CHAVE PÚBLICA VAPID
// GET /api/notifications/vapid-key
// ============================================
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ============================================
// REGISTAR SUBSCRIÇÃO
// POST /api/notifications/subscribe
// Body: { subscription } (objeto do browser)
// ============================================
router.post('/subscribe', auth, async (req, res) => {
  const { subscription } = req.body;
  const userId = req.user.userId;

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Subscrição inválida.' });
  }

  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = $3, auth = $4`,
      [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );

    res.json({ success: true, message: 'Notificações ativadas!' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registar subscrição.' });
  }
});

// ============================================
// ENVIAR NOTIFICAÇÃO PARA UM UTILIZADOR
// Função interna usada por outras rotas
// ============================================
async function sendNotification(userId, title, body, url = '/nexus/nexus-dashboard.html') {
  try {
    const result = await db.query(
      'SELECT * FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );

    const payload = JSON.stringify({ title, body, url });

    for (const sub of result.rows) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };

      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        // Se a subscrição expirou, apagar
        if (err.statusCode === 410) {
          await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
      }
    }
  } catch (err) {
    console.error('Erro ao enviar notificação:', err);
  }
}

// ============================================
// NOTIFICAR CHECK-IN DO RIVAL
// POST /api/notifications/checkin
// Body: { mission_id }
// ============================================
router.post('/checkin', auth, async (req, res) => {
  const { mission_id } = req.body;
  const userId = req.user.userId;

  try {
    const missionRes = await db.query(
      `SELECT m.*, u.username AS user_name
       FROM missions m
       JOIN users u ON u.id = $2
       WHERE m.id = $1 AND (m.user_id = $2 OR m.partner_id = $2)`,
      [mission_id, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission || !mission.partner_id) return res.json({ sent: false });

    // Determinar quem é o rival
    const rivalId = mission.user_id === userId ? mission.partner_id : mission.user_id;

    await sendNotification(
      rivalId,
      '🔥 O teu rival fez check-in!',
      `${mission.user_name} completou o dia de hoje. Vai à frente de ti!`,
      '/nexus/nexus-dashboard.html'
    );

    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao notificar.' });
  }
});

// ============================================
// NOTIFICAR NOVA MENSAGEM
// POST /api/notifications/message
// Body: { mission_id, sender_name }
// ============================================
router.post('/message', auth, async (req, res) => {
  const { mission_id, sender_name } = req.body;
  const userId = req.user.userId;

  try {
    const missionRes = await db.query(
      'SELECT * FROM missions WHERE id = $1 AND (user_id = $2 OR partner_id = $2)',
      [mission_id, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission || !mission.partner_id) return res.json({ sent: false });

    const rivalId = mission.user_id === userId ? mission.partner_id : mission.user_id;

    await sendNotification(
      rivalId,
      '💬 Nova mensagem no Nexus',
      `${sender_name}: enviou-te uma mensagem no chat da missão.`,
      '/nexus/nexus-dashboard.html'
    );

    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao notificar.' });
  }
});

module.exports = { router, sendNotification };
