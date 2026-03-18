// ============================================
// NEXUS — Rotas de Missões
// Criar, ver, e fazer match
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================
// CRIAR MISSÃO
// POST /api/missions
// Body: { title, category, level, mode, description }
// ============================================
router.post('/', auth, async (req, res) => {
  const { title, category, level, mode, description } = req.body;
  const userId = req.user.userId;

  if (!title || !category) {
    return res.status(400).json({ error: 'Título e categoria são obrigatórios.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO missions (user_id, title, category, level, mode, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, title, category, level || 'iniciante', mode || 'solo', description]
    );

    const mission = result.rows[0];

    // Se escolheu parceiro ou rival, tentar encontrar match imediatamente
    if (mode === 'parceiro' || mode === 'rival') {
      const match = await findMatch(mission, userId, db);
      if (match) {
        // Match encontrado — ligar as duas missões
        await activateMission(mission.id, match.user_id, db);
        await activateMission(match.id, userId, db);
        return res.status(201).json({
          mission,
          matched: true,
          matchedWith: match.user_id,
          message: 'Match encontrado! A missão começa agora.'
        });
      }
    }

    res.status(201).json({
      mission,
      matched: false,
      message: mode === 'solo'
        ? 'Missão solo criada.'
        : 'Na fila de espera. Vais receber notificação quando houver match.'
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar missão.' });
  }
});

// ============================================
// VER MISSÃO
// GET /api/missions/:id
// ============================================
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT m.*,
              u1.username AS user_name,
              u2.username AS partner_name
       FROM missions m
       LEFT JOIN users u1 ON m.user_id   = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.id = $1`,
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Missão não encontrada.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter missão.' });
  }
});

// ============================================
// LISTAR MISSÕES DO UTILIZADOR
// GET /api/missions
// ============================================
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT m.*, u.username AS partner_name
       FROM missions m
       LEFT JOIN users u ON m.partner_id = u.id
       WHERE m.user_id = $1
       ORDER BY m.created_at DESC`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar missões.' });
  }
});

// ============================================
// LÓGICA DE MATCH
// Procura alguém na fila de espera com
// objetivo compatível
// ============================================
async function findMatch(newMission, currentUserId, db) {
  // Procura missões em espera na mesma categoria e modo
  // com utilizador diferente
  const result = await db.query(
    `SELECT * FROM missions
     WHERE status   = 'waiting'
       AND mode     = $1
       AND category = $2
       AND user_id  != $3
     ORDER BY created_at ASC
     LIMIT 1`,
    [newMission.mode, newMission.category, currentUserId]
  );

  // Se não encontrou categoria exata, tenta match mais amplo
  if (!result.rows[0]) {
    const broad = await db.query(
      `SELECT * FROM missions
       WHERE status  = 'waiting'
         AND mode    = $1
         AND user_id != $2
       ORDER BY created_at ASC
       LIMIT 1`,
      [newMission.mode, currentUserId]
    );
    return broad.rows[0] || null;
  }

  return result.rows[0];
}

// Ativa uma missão com o parceiro encontrado
async function activateMission(missionId, partnerId, db) {
  const now = new Date();
  const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 dias

  await db.query(
    `UPDATE missions
     SET status     = 'active',
         partner_id = $1,
         started_at = $2,
         ends_at    = $3
     WHERE id = $4`,
    [partnerId, now, endsAt, missionId]
  );
}

module.exports = router;
