// ============================================
// NEXUS - Rotas de Mensagens
// Chat entre parceiro e rival
// ============================================

const express = require('express');
const { db } = require('../lib/db');
const auth = require('../middleware/auth');
const { classifyNote } = require('../lib/crisis-filter');
const router = express.Router();

// Filtro de crise no chat do Duo/Rival (PR A do plano do chat, decisão do
// dono do projeto de 21/11). O mesmo filtro da nota do check-in e dos posts.
// Com alerta: a mensagem não é gravada, nenhum aviso sai, o parceiro não sabe
// de nada e o texto não vai para log. A resposta leva crisis + crisis_level
// para o site abrir a ajuda. Texto calmo no molde do assistente e dos posts.
const MESSAGE_CRISIS_MESSAGE = 'Sua mensagem não foi enviada. Parece que você está passando por um momento difícil. Veja os contatos de ajuda.';

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
// ============================================
router.post('/', auth, async (req, res) => {
  const { mission_id, content } = req.body;
  const userId = req.user.userId;

  // Antes de qualquer consulta ao banco (e antes da checagem de duplicata):
  // com alerta, nada é lido nem gravado. Vale também para quem não tem acesso
  // à missão: a pessoa vê a ajuda e nada é revelado sobre a missão.
  const crisisLevel = typeof content === 'string' ? classifyNote(content) : null;
  if (crisisLevel) {
    return res.status(200).json({
      sent: false,
      crisis: true,
      crisis_level: crisisLevel,
      message: MESSAGE_CRISIS_MESSAGE
    });
  }

  const trimmedContent = content?.trim();

  if (!mission_id || !trimmedContent) {
    return res.status(400).json({ error: 'mission_id e content sao obrigatorios.' });
  }

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

    const duplicateRes = await db.query(
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
      return res.status(200).json({ message: duplicateRes.rows[0], deduped: true });
    }

    const insertRes = await db.query(
      `INSERT INTO messages (mission_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [mission_id, userId, trimmedContent]
    );

    const messageRes = await db.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [insertRes.rows[0].id]
    );

    res.status(201).json({ message: messageRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao enviar mensagem.' });
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
