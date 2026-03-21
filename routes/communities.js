// ============================================
// NEXUS — Rotas das Comunidades
// Fase 5 — Modo Liga
// ============================================

const express  = require('express');
const { Pool } = require('pg');
const auth     = require('../middleware/auth');
const router   = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Patentes por missões completadas na categoria
function getRank(missionsDone) {
  if (missionsDone >= 10) return 'lenda';
  if (missionsDone >= 5)  return 'campeão';
  if (missionsDone >= 3)  return 'elite';
  if (missionsDone >= 1)  return 'veterano';
  return 'recruta';
}

// ============================================
// LISTAR COMUNIDADES
// GET /api/communities
// ============================================
router.get('/', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await db.query(
      `SELECT c.*,
        CASE WHEN cm.user_id IS NOT NULL THEN true ELSE false END AS is_member,
        cm.rank AS my_rank,
        cm.missions_done
       FROM communities c
       LEFT JOIN community_members cm
         ON cm.community_id = c.id AND cm.user_id = $1
       ORDER BY c.is_default DESC, c.member_count DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar comunidades.' });
  }
});

// ============================================
// VER COMUNIDADE
// GET /api/communities/:slug
// ============================================
router.get('/:slug', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const commRes = await db.query(
      `SELECT c.*,
        CASE WHEN cm.user_id IS NOT NULL THEN true ELSE false END AS is_member,
        cm.rank AS my_rank, cm.missions_done, cm.total_days
       FROM communities c
       LEFT JOIN community_members cm
         ON cm.community_id = c.id AND cm.user_id = $1
       WHERE c.slug = $2`,
      [userId, req.params.slug]
    );

    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });

    // Top 10 ranking
    const rankRes = await db.query(
      `SELECT cm.rank, cm.missions_done, cm.total_days, u.username
       FROM community_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.community_id = $1
       ORDER BY cm.missions_done DESC, cm.total_days DESC
       LIMIT 10`,
      [community.id]
    );

    // Posts recentes
    const postsRes = await db.query(
      `SELECT cp.*, u.username
       FROM community_posts cp
       JOIN users u ON cp.user_id = u.id
       WHERE cp.community_id = $1
       ORDER BY cp.created_at DESC
       LIMIT 20`,
      [community.id]
    );

    res.json({
      community,
      ranking: rankRes.rows,
      posts: postsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter comunidade.' });
  }
});

// ============================================
// ENTRAR NUMA COMUNIDADE
// POST /api/communities/:slug/join
// ============================================
router.post('/:slug/join', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const commRes = await db.query(
      'SELECT * FROM communities WHERE slug = $1',
      [req.params.slug]
    );
    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });

    // Contar missões completadas do utilizador nesta categoria
    const missionsRes = await db.query(
      `SELECT COUNT(*) as total FROM missions
       WHERE (user_id = $1 OR partner_id = $1)
         AND category = $2
         AND status = 'completed'`,
      [userId, community.category]
    );
    const missionsDone = parseInt(missionsRes.rows[0].total);
    const rank = getRank(missionsDone);

    // Adicionar membro
    await db.query(
      `INSERT INTO community_members (community_id, user_id, rank, missions_done)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_id, user_id) DO NOTHING`,
      [community.id, userId, rank, missionsDone]
    );

    // Atualizar contador de membros
    await db.query(
      'UPDATE communities SET member_count = member_count + 1 WHERE id = $1',
      [community.id]
    );

    res.json({
      success: true,
      rank,
      missions_done: missionsDone,
      message: `Bem-vindo à comunidade ${community.name}! A tua patente é ${rank}.`
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao entrar na comunidade.' });
  }
});

// ============================================
// PUBLICAR POST NO FÓRUM
// POST /api/communities/:slug/posts
// Body: { content }
// ============================================
router.post('/:slug/posts', auth, async (req, res) => {
  const { content } = req.body;
  const userId = req.user.userId;

  if (!content?.trim()) {
    return res.status(400).json({ error: 'Conteúdo não pode estar vazio.' });
  }

  try {
    const commRes = await db.query(
      'SELECT * FROM communities WHERE slug = $1',
      [req.params.slug]
    );
    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });

    // Verificar se é membro
    const memberRes = await db.query(
      'SELECT * FROM community_members WHERE community_id = $1 AND user_id = $2',
      [community.id, userId]
    );
    if (!memberRes.rows[0]) {
      return res.status(403).json({ error: 'Tens de ser membro para publicar.' });
    }

    // Verificar se completou pelo menos uma missão nesta categoria
    const completedRes = await db.query(
      `SELECT COUNT(*) as total FROM missions
       WHERE (user_id = $1 OR partner_id = $1)
         AND category = $2
         AND status = 'completed'`,
      [userId, community.category]
    );
    const completed = parseInt(completedRes.rows[0].total);
    if (completed === 0) {
      return res.status(403).json({
        error: 'Tens de completar uma missão nesta categoria para poder publicar.',
        locked: true
      });
    }

    const result = await db.query(
      `INSERT INTO community_posts (community_id, user_id, content)
       VALUES ($1, $2, $3) RETURNING *`,
      [community.id, userId, content.trim()]
    );

    res.status(201).json({ post: result.rows[0] });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao publicar post.' });
  }
});

// ============================================
// SUGESTÃO DE COMUNIDADE (IA)
// GET /api/communities/suggest/:category
// ============================================
router.get('/suggest/:category', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*, cm.rank AS my_rank
       FROM communities c
       LEFT JOIN community_members cm
         ON cm.community_id = c.id AND cm.user_id = $1
       WHERE c.category = $2
       ORDER BY c.member_count DESC
       LIMIT 3`,
      [req.user.userId, req.params.category]
    );

    res.json({
      category: req.params.category,
      suggestions: result.rows,
      message: result.rows.length > 0
        ? `Encontrámos ${result.rows.length} comunidade(s) para o teu objetivo!`
        : 'Ainda não há comunidades nesta categoria. Sê o primeiro a criar uma!'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sugerir comunidades.' });
  }
});

// ============================================
// CRIAR COMUNIDADE
// POST /api/communities
// Body: { name, description, category, icon, cover_color }
// ============================================
router.post('/', auth, async (req, res) => {
  const { name, description, category, icon, cover_color } = req.body;
  const userId = req.user.userId;

  if (!name || !category) {
    return res.status(400).json({ error: 'Nome e categoria são obrigatórios.' });
  }

  try {
    // Verificar patente do utilizador — precisa de ser pelo menos Elite
    const rankRes = await db.query(
      `SELECT COUNT(*) as total FROM missions
       WHERE (user_id = $1 OR partner_id = $1)
         AND status = 'completed'`,
      [userId]
    );
    const totalCompleted = parseInt(rankRes.rows[0].total);
    if (totalCompleted < 3) {
      return res.status(403).json({
        error: 'Precisas de completar pelo menos 3 missões para criar uma comunidade.',
        missions_done: totalCompleted,
        needed: 3
      });
    }

    const slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const result = await db.query(
      `INSERT INTO communities (name, slug, description, category, icon, cover_color, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, slug, description, category, icon || '⚡', cover_color || '#FF5C00', userId]
    );

    res.status(201).json({
      community: result.rows[0],
      message: 'Comunidade criada com sucesso!'
    });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe uma comunidade com este nome.' });
    }
    res.status(500).json({ error: 'Erro ao criar comunidade.' });
  }
});

// ============================================
// SUGESTÃO INTELIGENTE DE COMUNIDADE
// GET /api/communities/smart-suggest/:missionId
// Analisa desempenho e sugere comunidade a partir do dia 15
// ============================================
router.get('/smart-suggest/:missionId', auth, async (req, res) => {
  const userId = req.user.userId;

  try {
    // Buscar a missão
    const missionRes = await db.query(
      `SELECT * FROM missions WHERE id = $1 AND (user_id = $2 OR partner_id = $2)`,
      [req.params.missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada.' });

    // Calcular dia atual
    const started   = new Date(mission.started_at);
    const today     = new Date();
    const dayNumber = Math.floor((today - started) / (1000 * 60 * 60 * 24)) + 1;

    // Só sugerir a partir do dia 15
    if (dayNumber < 15) {
      return res.json({
        suggest: false,
        reason: 'too_early',
        day: dayNumber,
        message: `Ainda no dia ${dayNumber}. Sugestão disponível a partir do dia 15.`
      });
    }

    // Contar check-ins feitos até hoje
    const checkinRes = await db.query(
      `SELECT COUNT(*) as total FROM checkins
       WHERE mission_id = $1 AND user_id = $2 AND completed = true`,
      [mission.id, userId]
    );
    const checkinsDone = parseInt(checkinRes.rows[0].total);

    // Calcular consistência (% de dias feitos)
    const consistency = Math.round((checkinsDone / dayNumber) * 100);

    // Só sugerir se consistência >= 60%
    if (consistency < 60) {
      return res.json({
        suggest: false,
        reason: 'low_consistency',
        consistency,
        day: dayNumber,
        message: 'Mantém o ritmo para desbloquear a sugestão de comunidade!'
      });
    }

    // Buscar comunidade da categoria
    const commRes = await db.query(
      `SELECT c.*,
        CASE WHEN cm.user_id IS NOT NULL THEN true ELSE false END AS already_member
       FROM communities c
       LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = $1
       WHERE c.category = $2
       ORDER BY c.member_count DESC LIMIT 1`,
      [userId, mission.category]
    );

    const community = commRes.rows[0];
    if (!community) {
      return res.json({
        suggest: false,
        reason: 'no_community',
        message: 'Ainda não há comunidade para esta categoria.'
      });
    }

    // Já é membro — não sugerir
    if (community.already_member) {
      return res.json({
        suggest: false,
        reason: 'already_member',
        message: 'Já és membro desta comunidade!'
      });
    }

    res.json({
      suggest: true,
      day: dayNumber,
      consistency,
      checkins_done: checkinsDone,
      community: {
        id: community.id,
        name: community.name,
        slug: community.slug,
        icon: community.icon,
        description: community.description,
        member_count: community.member_count,
        cover_color: community.cover_color
      },
      message: `Estás a ir muito bem! ${consistency}% de consistência no dia ${dayNumber}.`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao gerar sugestão.' });
  }
});

module.exports = router;
