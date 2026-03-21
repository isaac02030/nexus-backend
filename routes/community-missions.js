// ============================================
// NEXUS — Missões Internas das Comunidades
// Solo, Duo e Maratona
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================
// LISTAR MISSÕES DE UMA COMUNIDADE
// GET /api/community-missions/:slug
// ============================================
router.get('/:slug', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const commRes = await db.query(
      'SELECT * FROM communities WHERE slug = $1',
      [req.params.slug]
    );
    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });

    const result = await db.query(
      `SELECT cm.*,
        u.username AS creator_name,
        COUNT(cmp.id) AS participant_count,
        CASE WHEN EXISTS(
          SELECT 1 FROM community_mission_participants
          WHERE community_mission_id = cm.id AND user_id = $1
        ) THEN true ELSE false END AS is_participant
       FROM community_missions cm
       LEFT JOIN users u ON cm.created_by = u.id
       LEFT JOIN community_mission_participants cmp ON cm.id = cmp.community_mission_id
       WHERE cm.community_id = $2
       GROUP BY cm.id, u.username
       ORDER BY cm.created_at DESC`,
      [userId, community.id]
    );

    res.json({ missions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar missões.' });
  }
});

// ============================================
// CRIAR MISSÃO INTERNA
// POST /api/community-missions/:slug
// Body: { title, description, mode, scope, duration_days, max_participants, starts_at }
// ============================================
router.post('/:slug', auth, async (req, res) => {
  const userId = req.user.userId;
  const { title, description, mode, scope, duration_days, max_participants, starts_at } = req.body;

  if (!title || !mode) {
    return res.status(400).json({ error: 'Título e modo são obrigatórios.' });
  }

  try {
    // Verificar se é membro da comunidade
    const commRes = await db.query(
      `SELECT c.*, cm.rank, cm.missions_done
       FROM communities c
       JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = $1
       WHERE c.slug = $2`,
      [userId, req.params.slug]
    );
    const community = commRes.rows[0];
    if (!community) {
      return res.status(403).json({ error: 'Tens de ser membro para criar missões.' });
    }

    // Verificar se completou pelo menos uma missão para criar
    if (community.missions_done < 1) {
      return res.status(403).json({
        error: 'Completa uma missão nesta categoria para poder criar missões internas.',
        locked: true
      });
    }

    // Calcular data de fim
    const start  = starts_at ? new Date(starts_at) : new Date();
    const endsAt = new Date(start.getTime() + (duration_days || 30) * 24 * 60 * 60 * 1000);

    const result = await db.query(
      `INSERT INTO community_missions
        (community_id, title, description, mode, scope, duration_days, max_participants, created_by, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')
       RETURNING *`,
      [community.id, title, description, mode, scope || 'mundial',
       duration_days || 30, max_participants || null, userId, start, endsAt]
    );

    // Criador entra automaticamente
    await db.query(
      `INSERT INTO community_mission_participants (community_mission_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [result.rows[0].id, userId]
    );

    res.status(201).json({
      mission: result.rows[0],
      message: 'Missão criada! Outros membros podem entrar agora.'
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar missão.' });
  }
});

// ============================================
// ENTRAR NUMA MISSÃO INTERNA
// POST /api/community-missions/:slug/:missionId/join
// ============================================
router.post('/:slug/:missionId/join', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const missionRes = await db.query(
      `SELECT cm.*, c.slug FROM community_missions cm
       JOIN communities c ON cm.community_id = c.id
       WHERE cm.id = $1 AND c.slug = $2`,
      [req.params.missionId, req.params.slug]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });
    if (mission.status !== 'open') return res.status(400).json({ error: 'Missão já não está aberta.' });

    // Verificar limite de participantes
    if (mission.max_participants) {
      const countRes = await db.query(
        'SELECT COUNT(*) as total FROM community_mission_participants WHERE community_mission_id = $1',
        [mission.id]
      );
      if (parseInt(countRes.rows[0].total) >= mission.max_participants) {
        return res.status(400).json({ error: 'Missão já está cheia.' });
      }
    }

    await db.query(
      `INSERT INTO community_mission_participants (community_mission_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [mission.id, userId]
    );

    // Se modo duo e já tem 2 participantes, ativar missão
    if (mission.mode === 'duo') {
      const countRes = await db.query(
        'SELECT COUNT(*) as total FROM community_mission_participants WHERE community_mission_id = $1',
        [mission.id]
      );
      if (parseInt(countRes.rows[0].total) >= 2) {
        await db.query(
          "UPDATE community_missions SET status = 'active' WHERE id = $1",
          [mission.id]
        );
      }
    }

    res.json({ success: true, message: 'Entraste na missão!' });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao entrar na missão.' });
  }
});

// ============================================
// CHECK-IN NUMA MISSÃO INTERNA
// POST /api/community-missions/:slug/:missionId/checkin
// ============================================
router.post('/:slug/:missionId/checkin', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const missionRes = await db.query(
      'SELECT * FROM community_missions WHERE id = $1',
      [req.params.missionId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    // Verificar se é participante
    const partRes = await db.query(
      'SELECT * FROM community_mission_participants WHERE community_mission_id = $1 AND user_id = $2',
      [mission.id, userId]
    );
    if (!partRes.rows[0]) return res.status(403).json({ error: 'Não és participante desta missão.' });

    // Calcular dia
    const started   = new Date(mission.starts_at);
    const today     = new Date();
    const dayNumber = Math.floor((today - started) / (1000 * 60 * 60 * 24)) + 1;

    // Verificar se já fez hoje
    const existing = await db.query(
      `SELECT * FROM checkins
       WHERE mission_id = $1 AND user_id = $2 AND day_number = $3`,
      [mission.id, userId, dayNumber]
    );
    const alreadyDone = existing.rows.length > 0;

    if (!alreadyDone) {
      // Registar check-in
      await db.query(
        `INSERT INTO checkins (mission_id, user_id, day_number, completed)
         VALUES ($1, $2, $3, true)
         ON CONFLICT DO NOTHING`,
        [mission.id, userId, dayNumber]
      );

      // Incrementar score do participante
      await db.query(
        `UPDATE community_mission_participants
         SET score = score + 1
         WHERE community_mission_id = $1 AND user_id = $2`,
        [mission.id, userId]
      );
    }

    res.json({
      success: true,
      already_done: alreadyDone,
      day: dayNumber,
      message: alreadyDone ? 'Já fizeste check-in hoje.' : `Dia ${dayNumber} registado! 🔥`
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer check-in.' });
  }
});

// ============================================
// RANKING DE UMA MISSÃO INTERNA
// GET /api/community-missions/:slug/:missionId/ranking
// ============================================
router.get('/:slug/:missionId/ranking', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT cmp.score, cmp.completed, u.username,
        ROW_NUMBER() OVER (ORDER BY cmp.score DESC) AS position
       FROM community_mission_participants cmp
       JOIN users u ON cmp.user_id = u.id
       WHERE cmp.community_mission_id = $1
       ORDER BY cmp.score DESC`,
      [req.params.missionId]
    );

    res.json({ ranking: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter ranking.' });
  }
});

module.exports = router;
