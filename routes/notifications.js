// ============================================
// NEXUS - Push Notifications
// Web Push API com VAPID + lembretes diarios
// ============================================

const express = require('express');
const webpush = require('web-push');
const { Pool } = require('pg');
const auth = require('../middleware/auth');

const router = express.Router();
const db = new Pool({ connectionString: process.env.DATABASE_URL });

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

let reminderSchedulerStarted = false;
let reminderSweepRunning = false;

router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/subscribe', auth, async (req, res) => {
  const { subscription } = req.body;
  const userId = req.user.userId;

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Subscricao invalida.' });
  }

  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = $3, auth = $4`,
      [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );

    res.json({ success: true, message: 'Notificacoes ativadas.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registar subscricao.' });
  }
});

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
        if (err.statusCode === 410) {
          await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
      }
    }
  } catch (err) {
    console.error('Erro ao enviar notificacao:', err);
  }
}

function buildCheckinNotification(mission, actorName) {
  if (mission.mode === 'duo') {
    return {
      title: 'O teu parceiro ja cumpriu.',
      body: `${actorName} ja fechou o dia. Falta o teu registo para manterem o pacto.`
    };
  }

  return {
    title: 'O teu rival mexeu-se primeiro.',
    body: `${actorName} ja registou o dia. Se nao responderes hoje, ele ganha terreno.`
  };
}

function buildReminderCopy(kind, mission, dayNumber) {
  const cleanTitle = (mission.title || 'A missao').trim();

  switch (kind) {
    case 'midday_recovery':
      return {
        title: 'Ontem falhou. Hoje ainda volta.',
        body: `${cleanTitle}: ainda cabe no dia ${dayNumber}. Volta antes da quebra virar padrao.`
      };
    case 'evening_recovery':
      return {
        title: 'Dois dias seguidos fazem padrao.',
        body: `${cleanTitle}: se hoje fechar vazio, a quebra ganha forma. Regista antes da noite fechar.`
      };
    case 'evening_nudge':
      return {
        title: 'O dia fecha sem registo.',
        body: `${cleanTitle}: ainda vais a tempo de defender o dia ${dayNumber}. Sem prova, hoje conta contra ti.`
      };
    case 'midday_nudge':
    default:
      return {
        title: 'Hoje ainda nao existe prova.',
        body: `${cleanTitle}: falta o teu registo no dia ${dayNumber}. Fecha o minimo antes de te afastares do ritmo.`
      };
  }
}

async function ensureReminderLogTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      kind VARCHAR(40) NOT NULL,
      sent_on DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, mission_id, kind, sent_on)
    )
  `);
}

async function wasReminderSent(userId, missionId, kind) {
  const result = await db.query(
    `SELECT 1
     FROM notification_log
     WHERE user_id = $1 AND mission_id = $2 AND kind = $3 AND sent_on = CURRENT_DATE
     LIMIT 1`,
    [userId, missionId, kind]
  );

  return result.rows.length > 0;
}

async function markReminderSent(userId, missionId, kind) {
  await db.query(
    `INSERT INTO notification_log (user_id, mission_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, mission_id, kind, sent_on) DO NOTHING`,
    [userId, missionId, kind]
  );
}

function getReminderKind(now, missedYesterday) {
  const hour = now.getHours();

  if (hour >= 12 && hour < 15) {
    return missedYesterday ? 'midday_recovery' : 'midday_nudge';
  }

  if (hour >= 19 && hour < 22) {
    return missedYesterday ? 'evening_recovery' : 'evening_nudge';
  }

  return null;
}

async function runReminderSweep() {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;

  try {
    await ensureReminderLogTable();

    const now = new Date();

    const missionsRes = await db.query(`
      SELECT
        m.id,
        m.title,
        m.mode,
        m.started_at,
        m.duration_days,
        m.user_id,
        m.partner_id,
        u1.username AS user_name,
        u2.username AS partner_name
      FROM missions m
      JOIN users u1 ON u1.id = m.user_id
      LEFT JOIN users u2 ON u2.id = m.partner_id
      WHERE m.status = 'active' AND m.started_at IS NOT NULL
    `);

    for (const mission of missionsRes.rows) {
      const startedAt = new Date(mission.started_at);
      const dayNumber = Math.floor((now - startedAt) / (1000 * 60 * 60 * 24)) + 1;

      if (dayNumber < 1 || dayNumber > mission.duration_days) continue;

      const checkinsRes = await db.query(
        `SELECT user_id, day_number
         FROM checkins
         WHERE mission_id = $1 AND completed = true AND day_number IN ($2, $3)`,
        [mission.id, dayNumber, Math.max(dayNumber - 1, 1)]
      );

      const todayDone = new Set(
        checkinsRes.rows.filter(row => row.day_number === dayNumber).map(row => row.user_id)
      );
      const yesterdayDone = new Set(
        checkinsRes.rows.filter(row => row.day_number === dayNumber - 1).map(row => row.user_id)
      );

      const participants = [
        { id: mission.user_id, username: mission.user_name },
        mission.partner_id ? { id: mission.partner_id, username: mission.partner_name } : null
      ].filter(Boolean);

      for (const participant of participants) {
        if (todayDone.has(participant.id)) continue;

        const missedYesterday = dayNumber > 1 && !yesterdayDone.has(participant.id);
        const reminderKind = getReminderKind(now, missedYesterday);
        if (!reminderKind) continue;

        const alreadySent = await wasReminderSent(participant.id, mission.id, reminderKind);
        if (alreadySent) continue;

        const copy = buildReminderCopy(reminderKind, mission, dayNumber);
        await sendNotification(participant.id, copy.title, copy.body);
        await markReminderSent(participant.id, mission.id, reminderKind);
      }
    }
  } catch (err) {
    console.error('Erro no motor de lembretes:', err);
  } finally {
    reminderSweepRunning = false;
  }
}

function startReminderScheduler() {
  if (reminderSchedulerStarted) return;
  reminderSchedulerStarted = true;

  ensureReminderLogTable().catch(err => {
    console.error('Erro ao preparar notification_log:', err);
  });

  setTimeout(runReminderSweep, 20000);
  setInterval(runReminderSweep, 15 * 60 * 1000);
}

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

    const rivalId = mission.user_id === userId ? mission.partner_id : mission.user_id;
    const copy = buildCheckinNotification(mission, mission.user_name);

    await sendNotification(
      rivalId,
      copy.title,
      copy.body,
      '/nexus/nexus-dashboard.html'
    );

    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao notificar.' });
  }
});

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
      'Ha uma resposta a tua espera.',
      `${sender_name} mexeu no chat da missao. Se deixares passar, perdes o ritmo da conversa.`,
      '/nexus/nexus-dashboard.html'
    );

    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao notificar.' });
  }
});

startReminderScheduler();

module.exports = { router, sendNotification };
