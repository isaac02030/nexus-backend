// ============================================
// NEXUS - Rotas de Mensagens
// Chat entre parceiro e rival
// ============================================

const express = require('express');
const { db } = require('../lib/db');
const auth = require('../middleware/auth');
const { classifyNote } = require('../lib/crisis-filter');
const { NOTE_MAX_CHARS, noteLength, validateNoteLimit } = require('../lib/note-limit');
const { messagesAllowedSql } = require('../lib/notification-preferences');
const { sendNotification } = require('./notifications');
const { endMatchInTransaction } = require('./missions');
const { ensureAdmin } = require('../lib/admin');
const { REPORT_REASONS, isValidReason, reasonLabel } = require('../lib/post-reports');
const router = express.Router();

// ---------- PR D: bloquear e denunciar (migração 011, decisão de 23/11) ----------
const BLOCK_DONE_MESSAGE = 'Pronto. O par foi encerrado e vocês não vão ser juntados de novo. A conversa sumiu para os dois.';
const BLOCK_NOT_PAIR_MESSAGE = 'Você só pode bloquear a pessoa que está no seu par agora.';
const BLOCK_UNAVAILABLE_MESSAGE = 'O bloqueio ainda não está disponível. Tente de novo mais tarde.';
const BLOCK_SERVER_ERROR_MESSAGE = 'Não deu para bloquear agora. Tente de novo daqui a pouco.';

// Denúncia de mensagem: os 5 motivos da denúncia de posts (lib/post-reports.js).
const MESSAGE_REPORTS_PER_DAY = 10;
const MREPORT_DONE_MESSAGE = 'Obrigado. Sua denúncia foi registrada.';
const MREPORT_CRISIS_SAVED_MESSAGE = 'Sua denúncia foi registrada, sem o texto que você escreveu. Parece que você está passando por um momento difícil. Veja os contatos de ajuda.';
const MREPORT_CRISIS_NOT_SENT_MESSAGE = 'Sua denúncia não foi enviada. Parece que você está passando por um momento difícil. Veja os contatos de ajuda.';
const MREPORT_REASON_MESSAGE = 'Escolha um dos motivos da lista e envie de novo.';
const MREPORT_DETAILS_NOT_TEXT_MESSAGE = 'O comentário precisa ser um texto. Escreva de novo e envie.';
const MREPORT_DETAILS_TOO_LONG_MESSAGE = `O comentário passou de ${NOTE_MAX_CHARS} caracteres. Encurte um pouco e envie de novo.`;
const MREPORT_NOT_FOUND_MESSAGE = 'Mensagem não encontrada nesta conversa.';
const MREPORT_OWN_MESSAGE = 'Você não pode denunciar a sua própria mensagem.';
const MREPORT_DUPLICATE_MESSAGE = 'Você já denunciou esta mensagem. Uma denúncia por pessoa já basta, obrigado.';
const MREPORT_QUOTA_MESSAGE = `Você já fez ${MESSAGE_REPORTS_PER_DAY} denúncias nas últimas 24 horas. Tente de novo amanhã.`;
const MREPORT_UNAVAILABLE_MESSAGE = 'A denúncia ainda não está disponível. Tente de novo mais tarde.';
const MREPORT_SERVER_ERROR_MESSAGE = 'Não deu para enviar a denúncia agora. Tente de novo daqui a pouco.';
const MOD_UNAVAILABLE_MESSAGE = 'A moderação do chat ainda não está disponível: falta aplicar a migração 011.';
const MOD_SERVER_ERROR_MESSAGE = 'Não deu para concluir agora. Tente de novo daqui a pouco.';

function isMissingSchema(err) {
  return err && (err.code === '42703' || err.code === '42P01');
}

// Id: inteiro positivo que cabe num INTEGER do Postgres.
function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return id <= 2147483647 ? id : null;
}

// A outra pessoa do par ATIVO desta missão, ou null. Par por mission_matches
// (cada um com a sua missão) ou Duo na mesma missão (partner_id).
async function activePartnerOf(queryable, mission, userId) {
  const pairRes = await queryable.query(
    `SELECT mm.id, ma.user_id AS user_a, mb.user_id AS user_b
     FROM mission_matches mm
     JOIN missions ma ON ma.id = mm.mission_a_id
     JOIN missions mb ON mb.id = mm.mission_b_id
     WHERE mm.status = 'active'
       AND (mm.mission_a_id = $1 OR mm.mission_b_id = $1)
     LIMIT 1`,
    [mission.id]
  );
  const pair = pairRes.rows[0];
  if (pair) {
    const other = Number(pair.user_a) === Number(userId) ? pair.user_b : pair.user_a;
    return { otherId: Number(other), matched: true };
  }
  if (!hasActivePair(mission)) return null;
  const other = Number(mission.user_id) === Number(userId) ? mission.partner_id : mission.user_id;
  return other == null ? null : { otherId: Number(other), matched: false };
}

// Filtro de crise no chat do Duo/Rival (PR A do plano do chat, decisão do
// dono do projeto de 21/11). O mesmo filtro da nota do check-in e dos posts.
// Com alerta: a mensagem não é gravada, nenhum aviso sai, o parceiro não sabe
// de nada e o texto não vai para log. A resposta leva crisis + crisis_level
// para o site abrir a ajuda. Texto calmo no molde do assistente e dos posts.
const MESSAGE_CRISIS_MESSAGE = 'Sua mensagem não foi enviada. Parece que você está passando por um momento difícil. Veja os contatos de ajuda.';

// PR B do plano do chat: tamanho, frequência e par ativo (sem migração).
// 280 caracteres reais, o mesmo limite da nota do check-in (lib/note-limit.js).
const MESSAGE_MAX_CHARS = NOTE_MAX_CHARS;
// Texto enorme: o filtro de crise lê só os primeiros 1000 caracteres (o
// servidor nunca filtra 1 MB). Com alerta neles, a pessoa vê a ajuda; sem
// alerta, recusa pelo tamanho, sem tocar no banco (decisão do Maestro, lado
// protetor). Entre 281 e este teto, o filtro lê o texto todo e depois vem o 400.
const MESSAGE_HARD_MAX_CHARS = 1000;
// Frequência por pessoa (estimativa do Vitrúvio, ajustável aqui).
const MESSAGES_PER_HOUR = 20;
const MESSAGES_PER_DAY = 200;

const MESSAGE_TOO_LONG_MESSAGE = `A mensagem passou de ${MESSAGE_MAX_CHARS} caracteres. Encurte um pouco e envie de novo.`;
const MESSAGE_NOT_TEXT_MESSAGE = 'A mensagem precisa ser um texto. Escreva de novo e envie.';
const MESSAGE_NO_PAIR_MESSAGE = 'A conversa só funciona enquanto o Duo ou o Rival estiver ativo.';
const MESSAGE_HOUR_LIMIT_MESSAGE = 'Você enviou muitas mensagens nesta hora. Espere um pouco e envie de novo.';
const MESSAGE_DAY_LIMIT_MESSAGE = 'Você chegou ao limite de mensagens de hoje. Amanhã dá para enviar de novo.';
const MESSAGE_SERVER_ERROR_MESSAGE = 'Erro ao enviar mensagem.';

// PR C: aviso de mensagem nova (decisão de 23/11). Texto fixo, sem nome nem
// trecho (a tela bloqueada não mostra nada da conversa). Interruptor próprio
// (migração 010, message_notice_opt_in), desligado por padrão. No máximo 1 por
// dia por conversa: notification_log com kind 'chat' (UNIQUE por pessoa,
// missão, tipo e dia). Mensagem barrada por crise nunca chega aqui.
const MESSAGE_NOTICE_TITLE = 'Você tem uma mensagem nova.';
const MESSAGE_NOTICE_BODY = '';
const MESSAGE_NOTICE_URL = '/nexus-v2/missao.html';
const MESSAGE_NOTICE_KIND = 'chat';

// Reserva o aviso do dia (só para quem ligou o aviso) e, se for o primeiro
// do dia nesta conversa, manda. Falha aqui nunca derruba o envio.
async function noticeNewMessage(recipientId, missionId) {
  try {
    const claim = await db.query(
      `INSERT INTO notification_log (user_id, mission_id, kind)
       SELECT u.id, $2, $3
       FROM users u
       WHERE u.id = $1
         AND ${messagesAllowedSql('u')}
       ON CONFLICT (user_id, mission_id, kind, sent_on) DO NOTHING
       RETURNING id`,
      [recipientId, missionId, MESSAGE_NOTICE_KIND]
    );
    if (!claim.rows[0]) return false;
    await sendNotification(recipientId, MESSAGE_NOTICE_TITLE, MESSAGE_NOTICE_BODY, MESSAGE_NOTICE_URL,
      { kind: 'messages' });
    return true;
  } catch (_) {
    // Sem log: nada da conversa vai para o console.
    return false;
  }
}

// Duo (parceiro) ou Rival com a outra pessoa ainda na missão. É a mesma
// regra que a saída da missão usa (routes/missions.js).
function hasActivePair(mission) {
  return ['parceiro', 'rival'].includes(mission.mode) && mission.partner_id != null;
}

function missionParticipantWhere(alias = 'm', userParam = '$2') {
  return `(
    ${alias}.user_id = ${userParam}
    OR ${alias}.partner_id = ${userParam}
  )`;
}

// ============================================
// ENVIAR MENSAGEM
// POST /api/messages
// Body: { mission_id, content }
//
// Ordem: filtro de crise (nos primeiros 1000 caracteres, se o texto for enorme)
// → texto enorme recusado (sem ler o banco) → texto válido e até
// 280 caracteres → missão do pedido → missão ativa → Duo/Rival ativo →
// (transação, com a linha da pessoa travada) duplicata → limite por hora e
// por dia → grava.
// ============================================
router.post('/', auth, async (req, res) => {
  const { mission_id, content } = req.body || {};
  const userId = req.user.userId;

  const tooBig = typeof content === 'string' && noteLength(content) > MESSAGE_HARD_MAX_CHARS;

  // Antes de qualquer consulta ao banco (e antes da checagem de duplicata):
  // com alerta, nada é lido nem gravado. Vale também para quem não tem acesso
  // à missão: a pessoa vê a ajuda e nada é revelado sobre a missão.
  const filtered = tooBig ? [...content].slice(0, MESSAGE_HARD_MAX_CHARS).join('') : content;
  const crisisLevel = typeof filtered === 'string' ? classifyNote(filtered) : null;
  if (crisisLevel) {
    return res.status(200).json({
      sent: false,
      crisis: true,
      crisis_level: crisisLevel,
      message: MESSAGE_CRISIS_MESSAGE
    });
  }
  if (tooBig) {
    return res.status(400).json({ error: MESSAGE_TOO_LONG_MESSAGE });
  }

  if (content != null && typeof content !== 'string') {
    return res.status(400).json({ error: MESSAGE_NOT_TEXT_MESSAGE });
  }
  const trimmedContent = (content || '').trim();

  if (!mission_id || !trimmedContent) {
    return res.status(400).json({ error: 'mission_id e content sao obrigatorios.' });
  }
  if (validateNoteLimit(trimmedContent)) {
    return res.status(400).json({ error: MESSAGE_TOO_LONG_MESSAGE });
  }

  let client;
  try {
    const missionRes = await db.query(
      `SELECT * FROM missions m
       WHERE id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [mission_id, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) {
      return res.status(403).json({ error: 'Sem acesso a esta missao.' });
    }
    if (mission.status !== 'active') {
      return res.status(400).json({ error: 'Missao nao esta ativa.' });
    }
    if (!hasActivePair(mission)) {
      return res.status(400).json({ error: MESSAGE_NO_PAIR_MESSAGE });
    }

    // Contar e gravar na mesma transação, com a linha da pessoa travada:
    // dois envios ao mesmo tempo não passam do limite (padrão dos posts).
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const duplicateRes = await client.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.mission_id = $1
         AND m.sender_id = $2
         AND m.content = $3
         AND m.created_at >= NOW() - INTERVAL '5 seconds'
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [mission_id, userId, trimmedContent]
    );
    if (duplicateRes.rows[0]) {
      await client.query('COMMIT');
      return res.status(200).json({ message: duplicateRes.rows[0], deduped: true });
    }

    const countRes = await client.query(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS last_hour,
              COUNT(*) AS last_day
       FROM messages
       WHERE sender_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    const lastHour = parseInt(countRes.rows[0].last_hour, 10) || 0;
    const lastDay = parseInt(countRes.rows[0].last_day, 10) || 0;
    if (lastDay >= MESSAGES_PER_DAY || lastHour >= MESSAGES_PER_HOUR) {
      await client.query('ROLLBACK');
      const perDay = lastDay >= MESSAGES_PER_DAY;
      return res.status(429).json({
        error: perDay ? MESSAGE_DAY_LIMIT_MESSAGE : MESSAGE_HOUR_LIMIT_MESSAGE,
        limit: perDay ? MESSAGES_PER_DAY : MESSAGES_PER_HOUR,
        period: perDay ? 'day' : 'hour'
      });
    }

    const insertRes = await client.query(
      `INSERT INTO messages (mission_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [mission_id, userId, trimmedContent]
    );

    const messageRes = await client.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [insertRes.rows[0].id]
    );
    await client.query('COMMIT');

    // A outra pessoa da missão recebe o aviso (se ligou o aviso).
    const recipientId = Number(mission.user_id) === Number(userId) ? mission.partner_id : mission.user_id;
    if (recipientId != null) await noticeNewMessage(recipientId, mission.id);

    res.status(201).json({ message: messageRes.rows[0] });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    // Sem log do erro: nada do pedido (nem o texto) vai para o console.
    res.status(500).json({ error: MESSAGE_SERVER_ERROR_MESSAGE });
  } finally {
    if (client) client.release();
  }
});

// ============================================
// BLOQUEAR O PAR
// POST /api/messages/:missionId/block
//
// Só o par ATIVO desta missão. Numa transação só: grava o bloqueio (impede um
// novo par entre os dois) e encerra o par (por mission_matches, a mesma parte
// de endLinkedMissionMatch; no Duo na mesma missão, o dono fica com ela em
// Solo). Se algo falha, nada muda. Ninguém é apagado. Antes da 011: 503 e
// nada muda.
// ============================================
router.post('/:missionId/block', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = parseId(req.params.missionId);
  if (!missionId) return res.status(403).json({ error: 'Sem acesso a esta missao.' });

  let client;
  try {
    const missionRes = await db.query(
      `SELECT * FROM missions m
       WHERE id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(403).json({ error: 'Sem acesso a esta missao.' });

    const partner = await activePartnerOf(db, mission, userId);
    if (!partner || partner.otherId === Number(userId)) {
      return res.status(400).json({ error: BLOCK_NOT_PAIR_MESSAGE });
    }

    // Bloqueio e fim do par numa transação só: ou os dois, ou nenhum.
    client = await db.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [userId, partner.otherId]
    );
    if (partner.matched) {
      const ended = await endMatchInTransaction(client, mission.id, userId);
      if (!ended) throw new Error('par já encerrado');
    } else {
      // Duo na mesma missão: a missão fica com o dono, em Solo.
      await client.query(
        `UPDATE missions
         SET mode = 'solo', partner_id = NULL, match_preference = NULL, pair_started_at = NULL
         WHERE id = $1`,
        [mission.id]
      );
    }
    await client.query('COMMIT');

    res.json({ blocked: true, message: BLOCK_DONE_MESSAGE });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    // Sem log: nada do pedido vai para o console.
    if (isMissingSchema(err)) return res.status(503).json({ error: BLOCK_UNAVAILABLE_MESSAGE });
    res.status(500).json({ error: BLOCK_SERVER_ERROR_MESSAGE });
  } finally {
    if (client) client.release();
  }
});

// ============================================
// DENUNCIAR UMA MENSAGEM
// POST /api/messages/:messageId/report
// Body: { reason, details? }
//
// Ordem: filtro de crise no comentário → id e motivo válidos → comentário até
// 280 → (transação, com a pessoa travada) a mensagem é desta conversa → não é
// a própria → cota de 10 por 24 horas → uma vez por pessoa → grava.
// Crise no comentário: a denúncia vale, o comentário não é gravado nem logado,
// e a resposta leva crisis + crisis_level. Recusada por outro motivo, a pessoa
// vê a ajuda do mesmo jeito.
// ============================================
router.post('/:messageId/report', auth, async (req, res) => {
  const userId = req.user.userId;
  const { reason, details } = req.body || {};

  const crisisLevel = typeof details === 'string' ? classifyNote(details) : null;
  const refuse = (status, payload) => {
    if (crisisLevel) {
      return res.status(200).json({
        reported: false,
        crisis: true,
        crisis_level: crisisLevel,
        message: MREPORT_CRISIS_NOT_SENT_MESSAGE
      });
    }
    return res.status(status).json(payload);
  };

  const messageId = parseId(req.params.messageId);
  if (!messageId) return refuse(404, { error: MREPORT_NOT_FOUND_MESSAGE });
  if (!isValidReason(reason)) return refuse(400, { error: MREPORT_REASON_MESSAGE });

  let cleanDetails = null;
  if (!crisisLevel && details != null) {
    if (typeof details !== 'string') return refuse(400, { error: MREPORT_DETAILS_NOT_TEXT_MESSAGE });
    const text = details.trim();
    if (noteLength(text) > NOTE_MAX_CHARS) return refuse(400, { error: MREPORT_DETAILS_TOO_LONG_MESSAGE });
    cleanDetails = text || null;
  }

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    // A mensagem tem de estar numa conversa de quem denuncia: na missão dela
    // (dona ou parceira) ou na missão do par ativo dela.
    const msgRes = await client.query(
      `SELECT msg.id, msg.sender_id
       FROM messages msg
       JOIN missions mi ON mi.id = msg.mission_id
       WHERE msg.id = $1
         AND (
           mi.user_id = $2 OR mi.partner_id = $2
           OR EXISTS (
             SELECT 1 FROM mission_matches mm
             JOIN missions mine ON mine.id IN (mm.mission_a_id, mm.mission_b_id)
             WHERE mm.status = 'active'
               AND mi.id IN (mm.mission_a_id, mm.mission_b_id)
               AND mine.user_id = $2
           )
         )`,
      [messageId, userId]
    );
    const message = msgRes.rows[0];
    if (!message) {
      await client.query('ROLLBACK');
      return refuse(404, { error: MREPORT_NOT_FOUND_MESSAGE });
    }
    if (Number(message.sender_id) === Number(userId)) {
      await client.query('ROLLBACK');
      return refuse(400, { error: MREPORT_OWN_MESSAGE });
    }

    const quotaRes = await client.query(
      `SELECT COUNT(*) AS total
       FROM message_reports
       WHERE reporter_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    if ((parseInt(quotaRes.rows[0].total, 10) || 0) >= MESSAGE_REPORTS_PER_DAY) {
      await client.query('ROLLBACK');
      return refuse(429, { error: MREPORT_QUOTA_MESSAGE, limit: MESSAGE_REPORTS_PER_DAY });
    }

    const insertRes = await client.query(
      `INSERT INTO message_reports (message_id, reporter_id, reason, details)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id, reporter_id) DO NOTHING
       RETURNING id`,
      [messageId, userId, reason, cleanDetails]
    );
    if (insertRes.rowCount !== 1) {
      await client.query('ROLLBACK');
      return refuse(409, { error: MREPORT_DUPLICATE_MESSAGE, already_reported: true });
    }
    await client.query('COMMIT');

    if (crisisLevel) {
      return res.status(201).json({
        reported: true,
        crisis: true,
        crisis_level: crisisLevel,
        message: MREPORT_CRISIS_SAVED_MESSAGE
      });
    }
    res.status(201).json({ reported: true, message: MREPORT_DONE_MESSAGE });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    // Sem log: nada do pedido (nem o comentário) vai para o console.
    if (isMissingSchema(err)) return refuse(503, { error: MREPORT_UNAVAILABLE_MESSAGE });
    refuse(500, { error: MREPORT_SERVER_ERROR_MESSAGE });
  } finally {
    if (client) client.release();
  }
});

// ============================================
// DENÚNCIAS DO CHAT (só admin)
// GET /api/messages/admin/reports
// A equipe vê só o trecho da mensagem, o motivo e o comentário. Nunca quem
// denunciou, nem os nomes de quem conversa. Fica antes de /:missionId.
// ============================================
router.get('/admin/reports', auth, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const result = await db.query(
      `SELECT r.id, r.message_id, r.reason, r.details, r.created_at,
              msg.content AS excerpt
       FROM message_reports r
       JOIN messages msg ON msg.id = r.message_id
       ORDER BY (r.reason = $1) DESC, r.created_at ASC
       LIMIT 100`,
      [REPORT_REASONS[0].code]
    );
    res.json({
      reports: result.rows.map((row) => ({
        id: row.id,
        message_id: row.message_id,
        excerpt: row.excerpt,
        reason: row.reason,
        reason_label: reasonLabel(row.reason),
        details: row.details,
        created_at: row.created_at
      }))
    });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MOD_UNAVAILABLE_MESSAGE });
    res.status(500).json({ error: MOD_SERVER_ERROR_MESSAGE });
  }
});

// ============================================
// VER CONVERSA DE UMA MISSAO
// GET /api/messages/:missionId
//
// A conversa é a do par ATUAL (decisão de 23/11, «a conversa some para os
// dois»; achados do Argos no PR 35). Só aparecem as mensagens:
//   - das missões do par atual (a própria e, no par por mission_matches, a do
//     outro lado);
//   - escritas pelas duas pessoas do par atual;
//   - enviadas depois do início deste par (started_at do mission_matches; no
//     Duo na mesma missão, pair_started_at, quando existe);
//   - e só se não houver bloqueio entre as duas.
// Sem par ativo (Solo, par encerrado, bloqueio): conversa vazia. Mensagens de
// um par antigo nunca aparecem para um par novo. Nada é apagado do banco.
// ============================================
router.get('/:missionId', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = parseId(String(req.params.missionId));
  if (!missionId) return res.status(403).json({ error: 'Sem acesso a esta missao.' });

  try {
    const missionRes = await db.query(
      `SELECT * FROM missions m
       WHERE id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) {
      return res.status(403).json({ error: 'Sem acesso a esta missao.' });
    }

    const empty = () => res.json({ mission_id: missionId, messages: [] });
    const conversation = await currentConversation(db, mission);
    if (!conversation) return empty();
    if (await blockedBetween(db, conversation.people)) return empty();

    const result = await db.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.mission_id = ANY($1::int[])
         AND m.sender_id = ANY($2::int[])
         AND ($3::timestamp IS NULL OR m.created_at >= $3::timestamp)
       ORDER BY m.created_at ASC, m.id ASC`,
      [conversation.missionIds, conversation.people, conversation.since]
    );

    res.json({ mission_id: missionId, messages: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter mensagens.' });
  }
});

// O par atual desta missão: { missionIds, people, since }, ou null sem par.
async function currentConversation(queryable, mission) {
  const pairRes = await queryable.query(
    `SELECT mm.mission_a_id, mm.mission_b_id, mm.started_at,
            ma.user_id AS user_a, mb.user_id AS user_b
     FROM mission_matches mm
     JOIN missions ma ON ma.id = mm.mission_a_id
     JOIN missions mb ON mb.id = mm.mission_b_id
     WHERE mm.status = 'active'
       AND (mm.mission_a_id = $1 OR mm.mission_b_id = $1)
     LIMIT 1`,
    [mission.id]
  );
  const pair = pairRes.rows[0];
  if (pair) {
    return {
      missionIds: [Number(pair.mission_a_id), Number(pair.mission_b_id)],
      people: [Number(pair.user_a), Number(pair.user_b)],
      since: pair.started_at || null
    };
  }
  if (!hasActivePair(mission)) return null;
  return {
    missionIds: [Number(mission.id)],
    people: [Number(mission.user_id), Number(mission.partner_id)],
    since: mission.pair_started_at || null
  };
}

// Há bloqueio entre as duas pessoas? Antes da 011 a tabela não existe: não há.
async function blockedBetween(queryable, people) {
  try {
    const res = await queryable.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
       LIMIT 1`,
      [people[0], people[1]]
    );
    return res.rows.length > 0;
  } catch (err) {
    if (isMissingSchema(err)) return false;
    throw err;
  }
}

module.exports = router;
