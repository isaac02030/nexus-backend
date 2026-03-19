// ============================================
// NEXUS — Porta Aberta
// Partilha de contactos após missão completa
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================
// ABRIR A PORTA
// POST /api/porta-aberta
// Body: { mission_id, contact } (email, instagram, telefone, etc)
// ============================================
router.post('/', auth, async (req, res) => {
  const { mission_id, contact } = req.body;
  const userId = req.user.userId;

  if (!mission_id || !contact?.trim()) {
    return res.status(400).json({ error: 'mission_id e contact são obrigatórios.' });
  }

  try {
    // Verificar que a missão está completa e o utilizador faz parte dela
    const missionRes = await db.query(
      `SELECT * FROM missions WHERE id = $1 AND (user_id = $2 OR partner_id = $2)`,
      [mission_id, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });
    if (mission.status !== 'completed') {
      return res.status(400).json({ error: 'A missão ainda não foi completada.' });
    }

    // Guardar o contacto na coluna certa (user ou partner)
    const isUser = mission.user_id === userId;
    const field  = isUser ? 'user_contact' : 'partner_contact';

    await db.query(
      `UPDATE missions SET ${field} = $1 WHERE id = $2`,
      [contact.trim(), mission_id]
    );

    // Verificar se o outro também já abriu a porta
    const updated = await db.query(
      `SELECT user_contact, partner_contact FROM missions WHERE id = $1`,
      [mission_id]
    );
    const m = updated.rows[0];
    const bothOpen = m.user_contact && m.partner_contact;

    res.json({
      success: true,
      both_open: bothOpen,
      // Se ambos abriram, devolver o contacto do outro
      partner_contact: bothOpen
        ? (isUser ? m.partner_contact : m.user_contact)
        : null,
      message: bothOpen
        ? 'A Porta Aberta está desbloqueada! 🔓'
        : 'Contacto guardado. A aguardar que o teu rival abra a porta também.'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao abrir a porta.' });
  }
});

// ============================================
// VER ESTADO DA PORTA
// GET /api/porta-aberta/:missionId
// ============================================
router.get('/:missionId', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const missionRes = await db.query(
      `SELECT m.*, u1.username AS user_name, u2.username AS partner_name
       FROM missions m
       LEFT JOIN users u1 ON m.user_id    = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.id = $1 AND (m.user_id = $2 OR m.partner_id = $2)`,
      [req.params.missionId, userId]
    );

    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    const isUser    = mission.user_id === userId;
    const myContact = isUser ? mission.user_contact : mission.partner_contact;
    const bothOpen  = mission.user_contact && mission.partner_contact;

    res.json({
      mission_id: mission.id,
      status: mission.status,
      i_opened: !!myContact,
      both_open: bothOpen,
      partner_name: isUser ? mission.partner_name : mission.user_name,
      partner_contact: bothOpen
        ? (isUser ? mission.partner_contact : mission.user_contact)
        : null
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar porta.' });
  }
});

module.exports = router;
