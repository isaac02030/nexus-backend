// ============================================
// NEXUS - Rotas de Mensagens
// Chat entre parceiro e rival
// ============================================

const express = require('express');
const { Pool } = require('pg');
const auth = require('../middleware/auth');
const router = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

function missionParticipantWhere(alias = 'm', userParam = '$2') {
  return `(
    ${alias}.user_id = ${userParam}
    OR ${alias}.partner_id = ${userParam}
    OR EXISTS (
      SELECT 1 FROM checkins c
      WHERE c.mission_id = ${alias}.id
        AND c.user_id = ${userParam}
    )
    OR EXISTS (
      SELECT 1 FROM messages msg
      WHERE msg.mission_id = ${alias}.id
        AND msg.sender_id = ${userParam}
    )
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

    if (!missionRes.rows[0]) {
      return res.status(403).json({ error: 'Sem acesso a esta missao.' });
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

    const result = await db.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.mission_id = $1
       ORDER BY m.created_at ASC, m.id ASC`,
      [req.params.missionId]
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
