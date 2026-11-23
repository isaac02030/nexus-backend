// ============================================
// NEXUS - Rotas de Mensagens
// Chat entre parceiro e rival
// ============================================

const express = require('express');
const { db } = require('../lib/db');
const auth = require('../middleware/auth');
const { classifyNote } = require('../lib/crisis-filter');
const { NOTE_MAX_CHARS, noteLength, validateNoteLimit } = require('../lib/note-limit');
const router = express.Router();

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
// VER CONVERSA DE UMA MISSAO
// GET /api/messages/:missionId
// ============================================
router.get('/:missionId', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const missionRes = await db.query(
      `SELECT * FROM missions m
       WHERE id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [req.params.missionId, userId]
    );

    if (!missionRes.rows[0]) {
      return res.status(403).json({ error: 'Sem acesso a esta missao.' });
    }

    const pairRes = await db.query(
      `SELECT mission_a_id, mission_b_id
       FROM mission_matches
       WHERE status = 'active'
         AND (mission_a_id = $1 OR mission_b_id = $1)
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
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.mission_id = ANY($1::int[])
       ORDER BY m.created_at ASC, m.id ASC`,
      [missionIds]
    );

    res.json({
      mission_id: parseInt(req.params.missionId, 10),
      messages: result.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter mensagens.' });
  }
});

module.exports = router;
