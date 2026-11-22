// ============================================
// NEXUS - GRANDE IRMAO
// Rota para disparar notificações contextuais
// ============================================

const crypto   = require('crypto');
const express  = require('express');
const { db } = require('../lib/db');
const auth     = require('../middleware/auth');
const { generateNotification } = require('../vertice');
const { sendNotification }     = require('./notifications');
const { newsAllowedSql }       = require('../lib/notification-preferences');
const {
  FREE_DAY_CHECKIN_MESSAGE,
  currentStreak,
  missionDayContextFor,
  normalizeStoredWeekdays,
  previousMissionDay
} = require('../lib/mission-days');
const router   = express.Router();

const DAY_MS = 1000 * 60 * 60 * 24;

// Compara a chave recebida com a esperada em tempo constante (o resumo
// sha256 deixa os dois do mesmo tamanho). Sem cabeçalho: não confere.
function sameSecret(received, expected) {
  if (typeof received !== 'string' || received === '') return false;
  const a = crypto.createHash('sha256').update(received).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Dia de hoje e dias da missão.
// Sem dias escolhidos (NULL, ou a migração 004 ainda não aplicada): o cálculo
// de sempre desta rota, todo dia é da missão e nada muda.
// Com dias escolhidos: o mesmo corte do check-in (routes/checkins.js), com o
// horário e o fuso da pessoa, para o Grande Irmão nunca cobrar um dia que o
// check-in recusaria como dia livre.
// startedOrNow: o envio para todos usava "agora" quando a missão ainda não
// começou; a mensagem do painel não. Mantido como era.
async function missionToday(mission, userId, { startedOrNow = false, now = new Date() } = {}) {
  if (!normalizeStoredWeekdays(mission.mission_weekdays)) {
    const started = new Date(startedOrNow ? (mission.started_at || now) : mission.started_at);
    return {
      dayNumber: Math.floor((now - started) / DAY_MS) + 1,
      isMissionDay: () => true
    };
  }
  const clockRes = await db.query(
    `SELECT to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone
     FROM users
     WHERE id = $1`,
    [userId]
  );
  const clock = clockRes.rows[0] || {};
  return missionDayContextFor(mission, clock.reminder_time, clock.timezone, now);
}

// Dia livre: dentro da missão, mas fora dos dias escolhidos no contrato.
function isFreeDay(dayNumber, durationDays, isMissionDay) {
  return Number.isInteger(dayNumber)
    && dayNumber >= 1
    && dayNumber <= Number(durationDays)
    && !isMissionDay(dayNumber);
}

// ============================================
// OBTER MENSAGEM DO GRANDE IRMAO PARA O UTILIZADOR
// GET /api/vertice/message
// Usado pelo dashboard para mostrar mensagem contextual
// ============================================
router.get('/message', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = req.query.mission_id ? Number(req.query.mission_id) : null;

  try {
    // Buscar missão ativa ou em espera
    let missionRes = await db.query(
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

    if (missionId) {
      missionRes = await db.query(
        `SELECT m.*, u.username AS partner_name
         FROM missions m
         LEFT JOIN users u ON (
           CASE WHEN m.user_id = $1 THEN m.partner_id ELSE m.user_id END = u.id
         )
         WHERE m.id = $2
           AND (m.user_id = $1 OR m.partner_id = $1)
           AND m.status IN ('active', 'waiting')
         LIMIT 1`,
        [userId, missionId]
      );
    }

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
    const { dayNumber, isMissionDay } = await missionToday(mission, userId);

    // Dia livre: o Grande Irmão não cobra check-in nem fala em falta.
    if (isFreeDay(dayNumber, mission.duration_days, isMissionDay)) {
      return res.json({
        message: FREE_DAY_CHECKIN_MESSAGE,
        day: dayNumber,
        mode: mission.mode,
        user_done: false,
        free_day: true
      });
    }

    const userCheckinRes = await db.query(
      `SELECT * FROM checkins WHERE mission_id = $1 AND user_id = $2 AND day_number = $3`,
      [mission.id, userId, dayNumber]
    );
    const userDoneToday = userCheckinRes.rows.length > 0 && userCheckinRes.rows[0].completed;
    const latestProof = userCheckinRes.rows[0]?.note || null;

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

    const streakDaysRes = await db.query(
      `SELECT day_number FROM checkins
       WHERE mission_id = $1 AND user_id = $2 AND completed = true
       ORDER BY day_number DESC`,
      [mission.id, userId]
    );
    const doneDays = new Set(streakDaysRes.rows.map(r => r.day_number));
    // Dias livres não contam nem quebram a sequência, como no check-in.
    const streak = currentStreak(doneDays, dayNumber, isMissionDay);
    // A recuperação olha o dia da missão anterior (pode ser antes de um dia livre).
    const previousDay = previousMissionDay(dayNumber, isMissionDay);
    const recoveryNeeded = previousDay >= 1 && !doneDays.has(previousDay) && !userDoneToday;

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
      category: mission.category,
      dayNumber,
      streak,
      userScore,
      partnerScore,
      rivalDoneToday,
      partnerDoneToday,
      userDoneToday,
      recoveryNeeded,
      dailyMinimum: mission.daily_minimum,
      commitmentWindow: mission.commitment_window,
      whyItMatters: mission.why_it_matters,
      studyFocus: mission.study_focus,
      studyCurrentStage: mission.study_current_stage,
      studyTargetOutcome: mission.study_target_outcome,
      latestProof,
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
// NOVIDADES PARA QUEM ESCOLHEU RECEBER
// POST /api/vertice/notify-all
// Cabeçalho: x-vertice-secret (chave própria, VERTICE_SECRET)
// Body: { title, body } (o texto da novidade, igual para todos)
//
// Decisão de 22/11 (lembretes separados das novidades): só sai para quem
// tem novidades = sim (migração 009) e só com o conteúdo da novidade.
// Antes, esta rota mandava a frase do Grande Irmão sobre a missão a TODAS
// as missões ativas ou em espera, sem escolha da pessoa; isso saiu daqui
// (os lembretes da missão ficam no motor de lembretes, para quem tem
// lembretes = sim). Antes da 009: ninguém tem novidades = sim, nada sai.
// O texto da novidade não vai para log.
// ============================================
const NEWS_TITLE_MAX = 80;
const NEWS_BODY_MAX = 280;
const NEWS_CONTENT_MESSAGE = `Falta o texto da novidade: título (até ${NEWS_TITLE_MAX} caracteres) e texto (até ${NEWS_BODY_MAX}).`;

function newsText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || [...text].length > max) return null;
  return text;
}

router.post('/notify-all', async (req, res) => {
  // Chave própria deste endpoint (VERTICE_SECRET). Não usa o JWT_SECRET
  // como reserva: se a chave falta ou é igual à do login, fica desligado.
  const expected = process.env.VERTICE_SECRET;
  if (!expected || expected === process.env.JWT_SECRET) {
    return res.status(503).json({ error: 'O envio de avisos está desligado: falta configurar a chave própria dele (VERTICE_SECRET).' });
  }
  if (!sameSecret(req.headers['x-vertice-secret'], expected)) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  const title = newsText(req.body && req.body.title, NEWS_TITLE_MAX);
  const body = newsText(req.body && req.body.body, NEWS_BODY_MAX);
  if (!title || !body) {
    return res.status(400).json({ error: NEWS_CONTENT_MESSAGE, code: 'news_content_required' });
  }

  try {
    // Só quem disse sim às novidades e tem o push ligado em algum aparelho.
    const recipientsRes = await db.query(
      `SELECT u.id
       FROM users u
       WHERE ${newsAllowedSql('u')}
         AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id)
       ORDER BY u.id`
    );

    let sent = 0;
    for (const row of recipientsRes.rows) {
      const attempted = await sendNotification(row.id, title, body, undefined, { kind: 'news' });
      if (attempted > 0) sent++;
    }

    res.json({ success: true, notifications_sent: sent });
  } catch (err) {
    console.error('Erro no envio de novidades:', (err && (err.code || err.name)) || 'unknown');
    res.status(500).json({ error: 'Erro ao enviar notificações.' });
  }
});

module.exports = router;
