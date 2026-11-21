// ============================================
// NEXUS - Push Notifications
// Web Push API com VAPID + lembretes diarios.
// Quem escolheu horario: o principal sai nesse horario (fuso da pessoa),
// sempre com missao ativa. Os dois extras (alvo 13:00 e 20:30, entre
// 09:00 e 21:30) so saem sem check-in de hoje.
// O numero do dia e o corte do fim da missao usam o mesmo fuso da hora do aviso.
// Quem nao escolheu mantem as janelas antigas do relogio do servidor.
// O envio e so push: nao grava mensagem e nao conta no limite de chat.
// Dia livre (fora dos dias da missao escolhidos no contrato): nenhum
// lembrete, nem o principal nem os extras, na data local da pessoa.
// ============================================

const express = require('express');
const webpush = require('web-push');
const { db } = require('../lib/db');
const auth = require('../middleware/auth');
const {
  CHECKED_IN_ON_LOCAL_DATE_SQL,
  getDueReminders,
  getLegacyMissionDayNumber,
  getLocalDateKey,
  getMissionDayNumber,
  isMissionDayOpen,
  resolveReminderSettings
} = require('../lib/reminder-schedule');
const { missionDayChecker, startWeekdayFor } = require('../lib/mission-days');

const router = express.Router();

if (process.env.NODE_ENV !== 'test') {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

let reminderSchedulerStarted = false;
const reminderTimers = [];
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

function buildReminderCopy(kind, mission, dayNumber, options = {}) {
  const cleanTitle = (mission.title || 'A missao').trim();
  const checkedInToday = options.checkedInToday === true;

  if (kind === 'main') {
    if (checkedInToday) {
      return {
        title: 'O lembrete do teu horario.',
        body: `${cleanTitle}: dia ${dayNumber} ja tem registo.`
      };
    }

    return {
      title: 'Hora do teu lembrete.',
      body: `${cleanTitle}: este e o horario que escolheste. Falta o registo do dia ${dayNumber}.`
    };
  }

  if (typeof kind === 'string' && kind.startsWith('extra_')) {
    return {
      title: 'Hoje ainda nao existe prova.',
      body: `${cleanTitle}: falta o teu registo no dia ${dayNumber}.`
    };
  }

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

async function markReminderSent(userId, missionId, kind, sentOn = null) {
  if (sentOn) {
    await db.query(
      `INSERT INTO notification_log (user_id, mission_id, kind, sent_on)
       VALUES ($1, $2, $3, $4::date)
       ON CONFLICT (user_id, mission_id, kind, sent_on) DO NOTHING`,
      [userId, missionId, kind, sentOn]
    );
    return;
  }

  await db.query(
    `INSERT INTO notification_log (user_id, mission_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, mission_id, kind, sent_on) DO NOTHING`,
    [userId, missionId, kind]
  );
}

async function sentReminderKinds(userId, missionId, sentOn) {
  const result = sentOn
    ? await db.query(
      `SELECT kind
       FROM notification_log
       WHERE user_id = $1 AND mission_id = $2 AND sent_on = $3::date`,
      [userId, missionId, sentOn]
    )
    : await db.query(
      `SELECT kind
       FROM notification_log
       WHERE user_id = $1 AND mission_id = $2 AND sent_on = CURRENT_DATE`,
      [userId, missionId]
    );

  return result.rows.map(row => row.kind);
}

async function deliverDueReminders(participant, mission, now, dayNumber, todayDone, yesterdayDone, isMissionDay = () => true) {
  const settings = resolveReminderSettings(participant.reminderTime, participant.timezone);
  if (settings.mode === 'invalid') return;

  // Ontem livre nao e falta: o aviso de recuperacao ("Ontem falhou") so sai
  // quando ontem era dia da missao.
  const missedYesterday = dayNumber > 1
    && isMissionDay(dayNumber - 1)
    && !yesterdayDone.has(Number(participant.id));
  let checkedInToday = false;
  let sentOn = null;

  if (settings.mode === 'chosen') {
    sentOn = getLocalDateKey(now, settings.zone);
    if (!sentOn) return;

    const checked = await db.query(CHECKED_IN_ON_LOCAL_DATE_SQL, [
      mission.id,
      participant.id,
      settings.zone,
      sentOn
    ]);
    checkedInToday = checked.rows.length > 0;
  } else {
    checkedInToday = todayDone.has(Number(participant.id));
  }

  const due = getDueReminders({
    now,
    reminderTime: settings.mode === 'chosen' ? settings.clock : null,
    timezone: settings.mode === 'chosen' ? settings.zone : null,
    hasActiveMission: true,
    checkedInToday,
    missedYesterday,
    alreadySent: await sentReminderKinds(participant.id, mission.id, sentOn)
  });

  for (const item of due) {
    const copy = buildReminderCopy(item.slot, mission, dayNumber, { checkedInToday });
    // So push. Nao entra em messages nem no assistente, entao nao conta no limite de chat.
    await sendNotification(participant.id, copy.title, copy.body);
    await markReminderSent(participant.id, mission.id, item.slot, item.localDate);
  }
}

function missionDayFor(participant, mission, now) {
  const settings = resolveReminderSettings(participant.reminderTime, participant.timezone);
  if (settings.mode === 'invalid') return null;

  // O fuso da hora do aviso. Sem horario escolhido, fica o calculo antigo.
  const zone = settings.mode === 'chosen' ? settings.zone : null;
  const dayNumber = zone
    ? getMissionDayNumber(mission.started_at, now, zone)
    : getLegacyMissionDayNumber(mission.started_at, now);

  if (!isMissionDayOpen(dayNumber, mission.duration_days)) return null;

  // Mesmo corte do check-in: o dia da semana vem do Dia 1 nesse fuso.
  const isMissionDay = missionDayChecker(mission.mission_weekdays, startWeekdayFor(mission.started_at, zone));
  if (!isMissionDay(dayNumber)) return null;
  return { dayNumber, isMissionDay };
}

async function runReminderSweep(now = new Date()) {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;

  try {
    // mission_weekdays via to_jsonb: NULL (todos os dias) enquanto a
    // migracao 004 nao estiver aplicada, sem quebrar a consulta.
    const missionsRes = await db.query(`
      SELECT
        m.id,
        m.title,
        m.mode,
        m.started_at,
        m.duration_days,
        to_jsonb(m) -> 'mission_weekdays' AS mission_weekdays,
        m.user_id,
        m.partner_id,
        to_char(u1.reminder_time, 'HH24:MI') AS user_reminder_time,
        u1.timezone AS user_timezone,
        to_char(u2.reminder_time, 'HH24:MI') AS partner_reminder_time,
        u2.timezone AS partner_timezone
      FROM missions m
      JOIN users u1 ON u1.id = m.user_id
      LEFT JOIN users u2 ON u2.id = m.partner_id
      WHERE m.status = 'active' AND m.started_at IS NOT NULL
    `);

    for (const mission of missionsRes.rows) {
      const participants = [
        {
          id: mission.user_id,
          reminderTime: mission.user_reminder_time,
          timezone: mission.user_timezone
        },
        mission.partner_id ? {
          id: mission.partner_id,
          reminderTime: mission.partner_reminder_time,
          timezone: mission.partner_timezone
        } : null
      ].filter(Boolean);

      const active = [];
      for (const participant of participants) {
        const day = missionDayFor(participant, mission, now);
        if (day == null) continue;
        active.push({ participant, dayNumber: day.dayNumber, isMissionDay: day.isMissionDay });
      }
      if (active.length === 0) continue;

      const dayNumbers = [...new Set(active.flatMap((item) => [
        item.dayNumber,
        Math.max(item.dayNumber - 1, 1)
      ]))];
      const placeholders = dayNumbers.map((_, index) => `$${index + 2}`).join(', ');
      const checkinsRes = await db.query(
        `SELECT user_id, day_number
         FROM checkins
         WHERE mission_id = $1 AND completed = true AND day_number IN (${placeholders})`,
        [mission.id, ...dayNumbers]
      );

      for (const item of active) {
        const todayDone = new Set(
          checkinsRes.rows
            .filter(row => Number(row.day_number) === item.dayNumber)
            .map(row => Number(row.user_id))
        );
        const yesterdayDone = new Set(
          checkinsRes.rows
            .filter(row => Number(row.day_number) === item.dayNumber - 1)
            .map(row => Number(row.user_id))
        );

        try {
          await deliverDueReminders(
            item.participant,
            mission,
            now,
            item.dayNumber,
            todayDone,
            yesterdayDone,
            item.isMissionDay
          );
        } catch (err) {
          console.error('Erro ao avaliar lembrete:', err.message);
        }
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

  reminderTimers.push(setTimeout(runReminderSweep, 20000));
  reminderTimers.push(setInterval(runReminderSweep, 15 * 60 * 1000));
}

// Para os lembretes no desligamento (antes de fechar o Pool).
function stopReminderScheduler() {
  for (const timer of reminderTimers) clearTimeout(timer);
  reminderTimers.length = 0;
  reminderSchedulerStarted = false;
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

if (process.env.NODE_ENV !== 'test') {
  startReminderScheduler();
}

module.exports = { router, sendNotification, runReminderSweep, stopReminderScheduler };
