// ============================================
// NEXUS - Rotas de Missoes
// Criar, ver e fazer match
// ============================================

const express = require('express');
const { Pool } = require('pg');
const auth = require('../middleware/auth');
const router = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });
let missionContractReady = false;

async function ensureMissionContractColumns() {
  if (missionContractReady) return;

  await db.query(`
    ALTER TABLE missions
      ADD COLUMN IF NOT EXISTS daily_minimum VARCHAR(120),
      ADD COLUMN IF NOT EXISTS commitment_window VARCHAR(120),
      ADD COLUMN IF NOT EXISTS why_it_matters TEXT,
      ADD COLUMN IF NOT EXISTS fallback_plan TEXT,
      ADD COLUMN IF NOT EXISTS proof_mode VARCHAR(40),
      ADD COLUMN IF NOT EXISTS study_focus VARCHAR(160),
      ADD COLUMN IF NOT EXISTS study_current_stage VARCHAR(160),
      ADD COLUMN IF NOT EXISTS study_target_outcome TEXT
  `);

  missionContractReady = true;
}

router.post('/', auth, async (req, res) => {
  const {
    title,
    category,
    level,
    mode,
    description,
    daily_minimum,
    commitment_window,
    why_it_matters,
    fallback_plan,
    proof_mode,
    study_focus,
    study_current_stage,
    study_target_outcome
  } = req.body;
  const userId = req.user.userId;

  if (!title || !category) {
    return res.status(400).json({ error: 'Titulo e categoria sao obrigatorios.' });
  }

  try {
    await ensureMissionContractColumns();

    const result = await db.query(
      `INSERT INTO missions (
         user_id, title, category, level, mode, description,
         daily_minimum, commitment_window, why_it_matters, fallback_plan, proof_mode,
         study_focus, study_current_stage, study_target_outcome
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        userId,
        title,
        category,
        level || 'iniciante',
        mode || 'solo',
        description || null,
        daily_minimum || null,
        commitment_window || null,
        why_it_matters || null,
        fallback_plan || null,
        proof_mode || 'self_report',
        study_focus || null,
        study_current_stage || null,
        study_target_outcome || null
      ]
    );

    const mission = result.rows[0];

    if (mode === 'parceiro' || mode === 'rival') {
      const match = await findMatch(mission, userId, db);
      if (match) {
        await activateMission(mission.id, match, db);
        return res.status(201).json({
          mission,
          matched: true,
          matchedWith: match.user_id,
          message: 'Match encontrado! A missao comeca agora.'
        });
      }
    }

    res.status(201).json({
      mission,
      matched: false,
      message: mode === 'solo'
        ? 'Missao solo criada.'
        : 'Entraste na fila da tua categoria. Vais ser avisado quando aparecer alguem compativel.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar missao.' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    await ensureMissionContractColumns();

    const result = await db.query(
      `SELECT m.*,
              u1.username AS user_name,
              u2.username AS partner_name
       FROM missions m
       LEFT JOIN users u1 ON m.user_id = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.id = $1`,
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Missao nao encontrada.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter missao.' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    await ensureMissionContractColumns();

    const result = await db.query(
      `SELECT m.*,
        CASE WHEN m.user_id = $1
          THEN u2.username
          ELSE u1.username
        END AS partner_name
       FROM missions m
       LEFT JOIN users u1 ON m.user_id = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.user_id = $1 OR m.partner_id = $1
       ORDER BY m.created_at DESC`,
      [req.user.userId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar missoes.' });
  }
});

router.delete('/:id/waiting', auth, async (req, res) => {
  const missionId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `DELETE FROM missions
       WHERE id = $1 AND user_id = $2 AND status = 'waiting'
       RETURNING id`,
      [missionId, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Missao em espera nao encontrada.' });
    }

    res.json({ success: true, message: 'Saíste da fila de espera.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sair da fila.' });
  }
});

async function findMatch(newMission, currentUserId, db) {
  const exact = await db.query(
    `SELECT * FROM missions
     WHERE status = 'waiting'
       AND mode = $1
       AND category = $2
       AND user_id != $3
     ORDER BY created_at ASC
     LIMIT 1`,
    [newMission.mode, newMission.category, currentUserId]
  );

  return exact.rows[0] || null;
}

async function activateMission(newMissionId, matchedMission, db) {
  const now = new Date();
  const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await db.query(
    `UPDATE missions
     SET status = 'active',
         partner_id = $1,
         started_at = $2,
         ends_at = $3
     WHERE id = $4`,
    [matchedMission.user_id, now, endsAt, newMissionId]
  );

  await db.query(
    `DELETE FROM missions WHERE id = $1`,
    [matchedMission.id]
  );
}

module.exports = router;
