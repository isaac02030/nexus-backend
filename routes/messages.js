// ============================================
// NEXUS — Rotas de Mensagens
// Chat entre parceiro e rival
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================
// ENVIAR MENSAGEM
// POST /api/messages
// Body: { mission_id, content }
// ============================================
router.post('/', auth, async (req, res) => {
  const { mission_id, content } = req.body;
  const userId = req.user.userId;

  if (!mission_id || !content?.trim()) {
    return res.status(400).json({ error: 'mission_id e content são obrigatórios.' });
  }

  try {
    // Verificar que o utilizador faz parte desta missão
    const missionRes = await db.query(
      `SELECT * FROM missions
       WHERE id = $1 AND (user_id = $2 OR partner_id = $2)`,
      [mission_id, userId]
    );

    if (!missionRes.rows[0]) {
      return res.status(403).json({ error: 'Sem acesso a esta missão.' });
    }

    const result = await db.query(
      `INSERT INTO messages (mission_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [mission_id, userId, content.trim()]
    );

    res.status(201).json({ message: result.rows[0] });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao enviar mensagem.' });
  }
});

// ============================================
// VER CONVERSA DE UMA MISSÃO
// GET /api/messages/:missionId
// ============================================
router.get('/:missionId', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    // Verificar acesso
    const missionRes = await db.query(
      `SELECT * FROM missions
       WHERE id = $1 AND (user_id = $2 OR partner_id = $2)`,
      [req.params.missionId, userId]
    );

    if (!missionRes.rows[0]) {
      return res.status(403).json({ error: 'Sem acesso a esta missão.' });
    }

    // Buscar mensagens com o nome de quem enviou
    const result = await db.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.mission_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.missionId]
    );

    res.json({
      mission_id: parseInt(req.params.missionId),
      messages: result.rows
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter mensagens.' });
  }
});

module.exports = router;
