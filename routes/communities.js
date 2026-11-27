// ============================================
// NEXUS — Rotas das Comunidades
// Fase 5 — Modo Liga
// ============================================

const express  = require('express');
const { db } = require('../lib/db');
const auth     = require('../middleware/auth');
const { classifyNote } = require('../lib/crisis-filter');
const { NOTE_MAX_CHARS, noteLength } = require('../lib/note-limit');
const { ensureAdmin } = require('../lib/admin');
const { makeAdultGate, adultRequiredBody } = require('../lib/adult-gate');
const {
  postAccess, rankBySubject, areaLabel, isValidArea, AREA_INVALID_MESSAGE,
  isReadOnlyCommunity, READ_ONLY_MESSAGE, isEmojiIcon
} = require('../lib/community-access');
const { MERIT_RULE, meritCountSql, meritConditionSql, titleFor, nextTitle } = require('../lib/merit');
const {
  URGENT_REASON,
  FAST_TRACK_PER_DAY,
  REPEAT_ALERT_POSTS,
  isValidReason,
  reasonLabel,
  pickHiddenReason,
  shouldHide,
  hiddenMessage
} = require('../lib/post-reports');
const {
  PAGE_SIZE, CONTINUOUS_PAGE_SIZE, HIGHLIGHTS_MAX, HIGHLIGHTS_DAYS,
  encodeCursor, decodeCursor, dayDone
} = require('../lib/community-feed');
const router   = express.Router();

// Posts do fórum: mesmo limite de tamanho da frase do check-in (280
// caracteres reais) e no máximo 3 posts por pessoa a cada 24 horas,
// somando todas as comunidades.
const POST_MAX_CHARS = NOTE_MAX_CHARS;
const POSTS_PER_DAY = 3;

const POST_CRISIS_MESSAGE = 'Seu post não foi publicado. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const POST_NOT_TEXT_MESSAGE = 'O post precisa ser um texto. Escreva de novo e envie.';
const POST_EMPTY_MESSAGE = 'O post está vazio. Escreva alguma coisa e envie.';
const POST_TOO_LONG_MESSAGE = `O post passou de ${POST_MAX_CHARS} caracteres. Encurte um pouco e envie de novo.`;
const POST_NOT_MEMBER_MESSAGE = 'Só membros desta comunidade podem publicar. Entre na comunidade e tente de novo.';
// Antes da migração 013 (áreas), ninguém posta: falha segura, sem 500.
const POST_AREAS_UNAVAILABLE_MESSAGE = 'Os posts ainda não estão disponíveis. Tente de novo mais tarde.';
const RECOMMEND_UNAVAILABLE_MESSAGE = 'As recomendações ainda não estão disponíveis. Tente de novo mais tarde.';
const RECOMMEND_NO_AREA_MESSAGE = 'Esta missão não tem área. As recomendações aparecem para missões com área.';
const RECOMMEND_NOT_FOUND_MESSAGE = 'Missão não encontrada.';
const RECOMMEND_LIMIT = 20;

// Criar comunidade (decisões de 26/11: quem concluiu uma missão de 30 dias;
// área obrigatória). Textos novos para o sim do dono do projeto.
const CREATE_MIN_DAYS = 30;
const CREATE_NAME_MAX = 40;
const CREATE_TOPIC_MAX = 30;
const CREATE_DESCRIPTION_MAX = 200;
// Contra spam: no máximo 1 comunidade criada por pessoa a cada 7 dias
// (proposta; o número é fácil de trocar).
const CREATE_PER_WEEK = 1;
const CREATE_RESERVED_SLUGS = ['admin', 'suggest', 'smart-suggest', 'recommended', 'merit'];
const CREATE_CRISIS_MESSAGE = 'A comunidade não foi criada. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const CREATE_LOCKED_MESSAGE = 'Criar uma comunidade abre depois que você concluir uma missão de 30 dias.';
const CREATE_NAME_MESSAGE = `Dê um nome à comunidade, com até ${CREATE_NAME_MAX} caracteres.`;
const CREATE_NAME_LETTERS_MESSAGE = 'Use letras ou números no nome da comunidade.';
const CREATE_TOPIC_MESSAGE = `O assunto passou de ${CREATE_TOPIC_MAX} caracteres. Encurte um pouco e envie de novo.`;
const CREATE_DESCRIPTION_MESSAGE = `As regras passaram de ${CREATE_DESCRIPTION_MAX} caracteres. Encurte um pouco e envie de novo.`;
const CREATE_TEXT_MESSAGE = 'O nome, o assunto e as regras precisam ser texto. Escreva de novo e envie.';
const CREATE_DUPLICATE_MESSAGE = 'Já existe uma comunidade com esse nome.';
const CREATE_RATE_LIMIT_MESSAGE = 'Você já criou uma comunidade nesta semana. Tente de novo daqui a alguns dias.';
const CREATE_UNAVAILABLE_MESSAGE = 'Criar uma comunidade ainda não está disponível. Tente de novo mais tarde.';
const CREATE_ICON_MESSAGE = 'O ícone precisa ser um emoji. Escolha outro e envie de novo.';
const CREATE_SERVER_ERROR_MESSAGE = 'Não deu para criar a comunidade agora. Tente de novo daqui a pouco.';

// Texto curto opcional: espaços juntados; vazio vira null; não texto = erro.
function optionalText(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const text = value.replace(/\s+/g, ' ').trim();
  return { ok: true, value: text || null };
}

function slugOf(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
}
const POST_RATE_LIMIT_MESSAGE = `Você já publicou ${POSTS_PER_DAY} posts nas últimas 24 horas. Tente de novo amanhã.`;
const POST_SERVER_ERROR_MESSAGE = 'Não deu para publicar agora. Tente de novo daqui a pouco.';

// Mérito e ranking (PR D). Textos para o sim do dono do projeto.
const MERIT_SERVER_ERROR_MESSAGE = 'Não deu para abrir o mérito agora. Tente de novo daqui a pouco.';
const RANKING_TOP = 3;

// Denúncia de posts (regras em lib/post-reports.js).
const REPORT_DONE_MESSAGE = 'Obrigado. Sua denúncia foi registrada.';
const REPORT_CRISIS_SAVED_MESSAGE = 'Sua denúncia foi registrada, sem o texto que você escreveu. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const REPORT_CRISIS_NOT_SENT_MESSAGE = 'Sua denúncia não foi enviada. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const REPORT_REASON_MESSAGE = 'Escolha um dos motivos da lista e envie de novo.';
const REPORT_DETAILS_NOT_TEXT_MESSAGE = 'O comentário precisa ser um texto. Escreva de novo e envie.';
const REPORT_DETAILS_TOO_LONG_MESSAGE = `O comentário passou de ${NOTE_MAX_CHARS} caracteres. Encurte um pouco e envie de novo.`;
const REPORT_NOT_MEMBER_MESSAGE = 'Só membros desta comunidade podem denunciar posts. Entre na comunidade e tente de novo.';
const REPORT_POST_NOT_FOUND_MESSAGE = 'Post não encontrado. Ele pode ter sido apagado.';
const REPORT_OWN_POST_MESSAGE = 'Você não pode denunciar o seu próprio post.';
const REPORT_DUPLICATE_MESSAGE = 'Você já denunciou este post. Uma denúncia por pessoa já basta, obrigado.';
const REPORT_UNAVAILABLE_MESSAGE = 'A denúncia ainda não está disponível. Tente de novo mais tarde.';
const REPORT_SERVER_ERROR_MESSAGE = 'Não deu para enviar a denúncia agora. Tente de novo daqui a pouco.';

// Apoios e lista por cursor (PR C, migração 015). Textos para o sim do dono.
const SUPPORT_OWN_POST_MESSAGE = 'Você não pode apoiar o seu próprio post.';
const SUPPORT_DUPLICATE_MESSAGE = 'Você já apoiou este post.';
const SUPPORT_UNAVAILABLE_MESSAGE = 'O apoio ainda não está disponível. Tente de novo mais tarde.';
const SUPPORT_SERVER_ERROR_MESSAGE = 'Não deu para concluir agora. Tente de novo daqui a pouco.';
const FEED_UNAVAILABLE_MESSAGE = 'A lista de posts ainda não está disponível. Tente de novo mais tarde.';
const FEED_CURSOR_MESSAGE = 'Não deu para carregar mais posts. Abra a comunidade de novo.';
const FEED_SCROLL_HINT = 'Registre o dia para a lista rolar sozinha.';

// Moderação (só admin).
const MOD_POST_NOT_FOUND_MESSAGE = 'Post não encontrado.';
const MOD_NOT_HIDDEN_MESSAGE = 'Este post não está escondido.';
const MOD_UNAVAILABLE_MESSAGE = 'A moderação ainda não está disponível: falta aplicar a migração 005.';
const MOD_SERVER_ERROR_MESSAGE = 'Não deu para concluir agora. Tente de novo daqui a pouco.';

// Portão 18+ (lib/adult-gate.js): vale para tudo daqui, menos o admin.
const { hasAdultConfirmation, gate: adultGate } = makeAdultGate(db);

// Coluna ou tabela que ainda não existe (migração não aplicada).
function isMissingSchema(err) {
  return err && (err.code === '42703' || err.code === '42P01');
}

// Id de post: inteiro positivo que cabe num INTEGER do Postgres.
function parsePostId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return id <= 2147483647 ? id : null;
}

const CATEGORY_PROGRESS_SELECT = `
  COALESCE((
    SELECT COUNT(DISTINCT ch.day_number)
    FROM missions m2
    JOIN checkins ch ON ch.mission_id = m2.id
    WHERE ch.user_id = $1
      AND ch.completed = true
      AND m2.category = c.category
      AND (m2.user_id = $1 OR m2.partner_id = $1)
  ), 0) AS total_days,
  COALESCE((
    SELECT COUNT(*)
    FROM missions m3
    WHERE (m3.user_id = $1 OR m3.partner_id = $1)
      AND m3.category = c.category
      AND m3.status = 'completed'
  ), 0) AS missions_done
`;

// Decisão de 26/11 (áreas): ler o fórum é aberto a quem passou pelo
// portão 18+, sem precisar de missão nem de ser membro. Postar pede ser
// membro e ter uma missão ATIVA da mesma área (lib/community-access.js).
// As missões internas continuam com a regra antiga até o PR da Maratona.
function getCommunityAccess(community, post) {
  const isMember = !!community?.is_member;
  const missionsDone = Number(community?.missions_done) || 0;
  const totalDays = Number(community?.total_days) || 0;
  const canPostForum = isMember && !!post?.ok;
  const canCreateInternalMissions = isMember && missionsDone >= 1;
  const canViewInternalMissions = isMember && (totalDays >= 5 || missionsDone >= 1);

  return {
    is_member: isMember,
    missions_done: missionsDone,
    total_days: totalDays,
    can_read_forum: true,
    can_post_forum: canPostForum,
    post_code: !isMember && post?.ok ? 'not_member' : (post?.code || 'unavailable'),
    post_requirement: !isMember && post?.ok ? POST_NOT_MEMBER_MESSAGE : (post?.ok ? '' : (post?.message || POST_AREAS_UNAVAILABLE_MESSAGE)),
    can_view_internal_missions: canViewInternalMissions,
    can_create_internal_missions: canCreateInternalMissions,
    mission_requirement: 'Conclui 1 missão nesta categoria para criares missões internas.'
  };
}

// Áreas das missões ATIVAS da pessoa (dono ou parceiro do Duo). Missão
// concluída, abandonada ou pausada não conta. Quem saiu do Duo já não é
// partner_id, então não conta.
async function activeMissionAreas(userId) {
  const result = await db.query(
    `SELECT area FROM missions
     WHERE (user_id = $1 OR partner_id = $1)
       AND status = 'active'`,
    [userId]
  );
  return result.rows.map((row) => (row.area == null ? null : row.area));
}

// Pode postar nesta comunidade? Antes da 013 (sem a coluna area): não, com
// um aviso calmo (unavailable), nunca um 500.
async function checkPostAccess(userId, community) {
  const unavailable = { ok: false, code: 'unavailable', unavailable: true, message: POST_AREAS_UNAVAILABLE_MESSAGE };
  if (!community || !Object.prototype.hasOwnProperty.call(community, 'area')) return unavailable;
  // Só leitura / em breve (desligado por padrão: lib/community-access.js).
  if (isReadOnlyCommunity(community.slug)) {
    return { ok: false, code: 'read_only', message: READ_ONLY_MESSAGE };
  }
  try {
    const areas = await activeMissionAreas(userId);
    return postAccess(areas, community.area);
  } catch (err) {
    if (isMissingSchema(err)) return unavailable;
    throw err;
  }
}

// Patentes por missões completadas na categoria
function getRank(missionsDone) {
  if (missionsDone >= 10) return 'lenda';
  if (missionsDone >= 5)  return 'campeão';
  if (missionsDone >= 3)  return 'elite';
  if (missionsDone >= 1)  return 'veterano';
  return 'recruta';
}

// ============================================
// MODERAÇÃO (só admin, o mesmo critério de routes/insights.js)
// GET    /api/communities/admin/hidden-posts           → posts escondidos
// POST   /api/communities/admin/posts/:postId/restore  → volta a aparecer
// DELETE /api/communities/admin/posts/:postId          → apaga de vez
// Ficam antes do portão 18+ e de /:slug. Quem denunciou não aparece: só
// motivo, comentário e alertas.
// ============================================
router.get('/admin/hidden-posts', auth, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const result = await db.query(
      `SELECT cp.id, cp.community_id, c.slug AS community_slug, cp.user_id,
              u.username, cp.content, cp.created_at, cp.hidden_at, cp.hidden_reason,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'reason', r.reason,
                         'details', r.details,
                         'created_at', r.created_at
                       ) ORDER BY r.created_at)
                FROM community_post_reports r
                WHERE r.post_id = cp.id
              ), '[]'::json) AS reports,
              EXISTS (
                SELECT 1 FROM community_post_reports r2
                WHERE r2.post_id = cp.id AND r2.reason = $1
              ) AS urgent,
              EXISTS (
                SELECT 1 FROM community_post_reports r3
                WHERE r3.post_id = cp.id
                  AND r3.hid_post_at IS NOT NULL
                  AND (
                    SELECT COUNT(DISTINCT r4.post_id)
                    FROM community_post_reports r4
                    WHERE r4.reporter_id = r3.reporter_id
                      AND r4.hid_post_at > NOW() - INTERVAL '24 hours'
                  ) >= $2
              ) AS repeat_reporter_alert
       FROM community_posts cp
       JOIN communities c ON c.id = cp.community_id
       JOIN users u ON u.id = cp.user_id
       WHERE cp.hidden_at IS NOT NULL
       ORDER BY urgent DESC, cp.hidden_at ASC
       LIMIT 100`,
      [URGENT_REASON, REPEAT_ALERT_POSTS]
    );
    // Prioridade alta: alguma denúncia "perigoso" (saúde). Vêm primeiro.
    // repeat_reporter_alert: alguém que ajudou a esconder este post escondeu
    // 2 ou mais posts nas últimas 24 horas. Só o alerta, nunca quem é.
    res.json({
      posts: result.rows.map(({ urgent, ...post }) => ({
        ...post,
        priority: urgent ? 'alta' : 'normal',
        hidden_reason_label: reasonLabel(post.hidden_reason)
      }))
    });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MOD_UNAVAILABLE_MESSAGE });
    res.status(500).json({ error: MOD_SERVER_ERROR_MESSAGE });
  }
});

router.post('/admin/posts/:postId/restore', auth, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const postId = parsePostId(req.params.postId);
  if (!postId) return res.status(404).json({ error: MOD_POST_NOT_FOUND_MESSAGE });
  try {
    // restored_at: daqui em diante só contam denúncias novas.
    const result = await db.query(
      `UPDATE community_posts
       SET hidden_at = NULL, hidden_reason = NULL, restored_at = NOW()
       WHERE id = $1 AND hidden_at IS NOT NULL
       RETURNING id`,
      [postId]
    );
    if (result.rowCount === 1) {
      return res.json({ restored: true, post_id: postId });
    }
    const exists = await db.query('SELECT id FROM community_posts WHERE id = $1', [postId]);
    if (!exists.rows[0]) return res.status(404).json({ error: MOD_POST_NOT_FOUND_MESSAGE });
    res.status(409).json({ error: MOD_NOT_HIDDEN_MESSAGE });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MOD_UNAVAILABLE_MESSAGE });
    res.status(500).json({ error: MOD_SERVER_ERROR_MESSAGE });
  }
});

router.delete('/admin/posts/:postId', auth, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const postId = parsePostId(req.params.postId);
  if (!postId) return res.status(404).json({ error: MOD_POST_NOT_FOUND_MESSAGE });
  try {
    // As denúncias do post saem junto (ON DELETE CASCADE da migração 005).
    const result = await db.query(
      'DELETE FROM community_posts WHERE id = $1 RETURNING id',
      [postId]
    );
    if (result.rowCount !== 1) return res.status(404).json({ error: MOD_POST_NOT_FOUND_MESSAGE });
    res.json({ deleted: true, post_id: postId });
  } catch (err) {
    res.status(500).json({ error: MOD_SERVER_ERROR_MESSAGE });
  }
});

// ============================================
// PORTÃO 18+: daqui para baixo, tudo da comunidade (listar, sugerir, ver,
// entrar, publicar, denunciar, criar) exige login e 18+ confirmado.
// Sem a confirmação: 403 com code adult_confirmation_required.
// ============================================
router.use(adultGate);

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
        ${CATEGORY_PROGRESS_SELECT}
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

// As rotas com prefixo fixo (/suggest, /smart-suggest) ficam antes de /:slug.
// Hoje /:slug só pega um pedaço do caminho, então elas já respondiam; a ordem
// deixa isso explícito e evita que uma rota /:slug/... nova as esconda.

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

// ============================================
// COMUNIDADES RECOMENDADAS PARA UMA MISSÃO (sem IA)
// GET /api/communities/recommended/:missionId
// As da mesma área da missão; primeiro as com o assunto parecido (busca
// simples por palavra no nome, na descrição e na categoria). Só a própria
// missão (dono ou parceiro); a de outra pessoa dá 404, sem dizer se existe.
// ============================================
router.get('/recommended/:missionId', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = parsePostId(req.params.missionId);
  if (!missionId) return res.status(404).json({ error: RECOMMEND_NOT_FOUND_MESSAGE });
  try {
    const missionRes = await db.query(
      `SELECT id, area, subject FROM missions
       WHERE id = $1 AND (user_id = $2 OR partner_id = $2)`,
      [missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: RECOMMEND_NOT_FOUND_MESSAGE });
    if (mission.area == null) {
      return res.json({ area: null, subject: mission.subject || null, communities: [], message: RECOMMEND_NO_AREA_MESSAGE });
    }

    const commRes = await db.query(
      `SELECT c.id, c.name, c.slug, c.description, c.category, c.icon, c.cover_color,
              c.is_default, c.member_count, c.area,
              CASE WHEN cm.user_id IS NOT NULL THEN true ELSE false END AS is_member
       FROM communities c
       LEFT JOIN community_members cm
         ON cm.community_id = c.id AND cm.user_id = $1
       WHERE c.area = $2`,
      [userId, mission.area]
    );
    res.json({
      area: mission.area,
      area_label: areaLabel(mission.area),
      subject: mission.subject || null,
      communities: rankBySubject(mission.subject, commRes.rows).slice(0, RECOMMEND_LIMIT)
    });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: RECOMMEND_UNAVAILABLE_MESSAGE, code: 'unavailable' });
    res.status(500).json({ error: 'Erro ao recomendar comunidades.' });
  }
});

// ============================================
// MÉRITO E RANKING (PR D da comunidade; decisão de 27/11, títulos opção A)
// GET /api/communities/merit/me      → o meu mérito (só o próprio; não há
//                                      perfil dos outros)
// GET /api/communities/:slug/ranking → os 3 primeiros + a minha posição
// Contam só as missões pessoais de 30 dias concluídas (lib/merit.js).
// O ranking mostra só apelido, título, missões e dias na comunidade; nunca
// id, e-mail ou outra coisa. Quem não é membro, ou não tem missão que
// conta, não entra.
// ============================================
router.get('/merit/me', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ${meritCountSql('u.id')} AS missions FROM users u WHERE u.id = $1`,
      [req.user.userId]
    );
    const missions = Number(result.rows[0]?.missions) || 0;
    res.json({
      missions,
      title: titleFor(missions),
      next: nextTitle(missions),
      rule: MERIT_RULE
    });
  } catch (err) {
    res.status(500).json({ error: MERIT_SERVER_ERROR_MESSAGE });
  }
});

// Os 3 primeiros + quem pede. Ordem: missões desc, entrada na comunidade
// asc, id do membro asc (determinística).
async function communityRanking(communityId, userId) {
  const result = await db.query(
    `WITH members AS (
       -- Uma contagem agregada para todos os membros (não uma subconsulta
       -- por linha).
       SELECT cm.id AS member_id, cm.user_id, cm.created_at AS joined_at, u.username,
              COUNT(mm.id)::int AS missions
       FROM community_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN missions mm ON ${meritConditionSql('cm.user_id')}
       WHERE cm.community_id = $1
       GROUP BY cm.id, cm.user_id, cm.created_at, u.username
     ), ordered AS (
       SELECT member_id, user_id, joined_at, username, missions,
              ROW_NUMBER() OVER (ORDER BY missions DESC, joined_at ASC, member_id ASC) AS position
       FROM members
       WHERE missions > 0
     )
     SELECT position::int AS position, username, missions,
            FLOOR(EXTRACT(EPOCH FROM (NOW()::timestamp - joined_at)) / 86400)::int AS days_in_community,
            (user_id = $2) AS is_me
     FROM ordered
     WHERE position <= $3 OR user_id = $2
     ORDER BY position`,
    [communityId, userId, RANKING_TOP]
  );
  const rows = result.rows.map((row) => ({
    position: Number(row.position),
    username: row.username,
    title: titleFor(row.missions),
    missions: Number(row.missions) || 0,
    days_in_community: Math.max(0, Number(row.days_in_community) || 0),
    is_me: row.is_me === true
  }));
  return {
    top: rows.filter((row) => row.position <= RANKING_TOP),
    me: rows.find((row) => row.is_me) || null,
    rule: MERIT_RULE
  };
}

router.get('/:slug/ranking', auth, async (req, res) => {
  try {
    const commRes = await db.query('SELECT id FROM communities WHERE slug = $1', [req.params.slug]);
    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });
    res.json(await communityRanking(community.id, req.user.userId));
  } catch (err) {
    res.status(500).json({ error: MERIT_SERVER_ERROR_MESSAGE });
  }
});

// ============================================
// VER COMUNIDADE
// GET /api/communities/:slug
// Ler é aberto (18+): os posts vêm para todos, com ou sem missão.
// ============================================
router.get('/:slug', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const commRes = await db.query(
      `SELECT c.*,
        CASE WHEN cm.user_id IS NOT NULL THEN true ELSE false END AS is_member,
        cm.rank AS my_rank,
        ${CATEGORY_PROGRESS_SELECT}
       FROM communities c
       LEFT JOIN community_members cm
         ON cm.community_id = c.id AND cm.user_id = $1
       WHERE c.slug = $2`,
      [userId, req.params.slug]
    );

    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });
    const access = getCommunityAccess(community, await checkPostAccess(userId, community));

    // Ranking: os 3 primeiros + quem pede (antes eram os 10 primeiros, com
    // a patente antiga e os dias, gravados na entrada e já velhos).
    const ranking = await communityRanking(community.id, userId);

    // Posts recentes. Post escondido por denúncias some para todos, menos
    // para o autor, que o vê com hidden: true e o motivo. As colunas da
    // migração 005 são lidas por to_jsonb: antes dela, tudo sai visível,
    // como antes, sem quebrar a página.
    let posts = [];
    if (access.can_read_forum) {
      const postsRes = await db.query(
        `SELECT cp.id, cp.community_id, cp.user_id, cp.content, cp.created_at,
                u.username,
                (to_jsonb(cp) ->> 'hidden_at') IS NOT NULL AS hidden,
                CASE WHEN cp.user_id = $2 THEN to_jsonb(cp) ->> 'hidden_reason' END AS hidden_reason,
                ${meritCountSql('cp.user_id')} AS author_missions
         FROM community_posts cp
         JOIN users u ON cp.user_id = u.id
         WHERE cp.community_id = $1
           AND ((to_jsonb(cp) ->> 'hidden_at') IS NULL OR cp.user_id = $2)
         ORDER BY cp.created_at DESC
         LIMIT 20`,
        [community.id, userId]
      );
      // O título do autor (PR D): só o nome e o nível, calculados na leitura.
      posts = postsRes.rows.map(({ author_missions: authorMissions, ...row }) => ({
        ...row,
        author_title: titleFor(authorMissions)
      })).map((post) => {
        if (!post.hidden) {
          const { hidden_reason: _, ...visible } = post;
          return visible;
        }
        return {
          ...post,
          hidden_reason_label: reasonLabel(post.hidden_reason),
          hidden_message: hiddenMessage(post.hidden_reason)
        };
      });
    }

    res.json({
      community,
      ranking,
      posts,
      access
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter comunidade.' });
  }
});

// ============================================
// APOIOS, DESTAQUES E LISTA POR CURSOR (PR C da comunidade, migração 015)
// GET    /api/communities/:slug/posts?cursor=…             → página de posts
// GET    /api/communities/:slug/highlights                 → até 3 da semana
// POST   /api/communities/:slug/posts/:postId/support      → apoiar
// DELETE /api/communities/:slug/posts/:postId/support      → tirar o apoio
// Ler é aberto (18+). Apoiar: 18+, post visível, não o próprio, 1 por pessoa
// (UNIQUE). Só o total aparece; ninguém vê quem apoiou. Apoiar não dá moeda.
// Antes da 015: 503 calmo (a página GET /:slug continua funcionando).
// ============================================

// O dia de hoje está cumprido? (lib/community-feed.js). Qualquer falha:
// não cumprido, e a lista fica com o botão «Ver anteriores».
async function loadDayDone(userId) {
  try {
    const clockRes = await db.query(
      `SELECT to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone
       FROM users WHERE id = $1`,
      [userId]
    );
    const missionsRes = await db.query(
      `SELECT * FROM missions
       WHERE (user_id = $1 OR partner_id = $1)
         AND status = 'active'`,
      [userId]
    );
    const missions = missionsRes.rows;
    if (!missions.length) return false;
    const doneRes = await db.query(
      `SELECT mission_id, day_number FROM checkins
       WHERE user_id = $1 AND completed = true AND mission_id = ANY($2::int[])`,
      [userId, missions.map((m) => Number(m.id))]
    );
    const doneDays = new Map();
    for (const row of doneRes.rows) {
      const key = Number(row.mission_id);
      if (!doneDays.has(key)) doneDays.set(key, new Set());
      doneDays.get(key).add(Number(row.day_number));
    }
    return dayDone(missions, clockRes.rows[0] || {}, doneDays);
  } catch (err) {
    return false;
  }
}

// Título do autor (PR D): só o nome e o nível; o número cru não sai.
function withAuthorTitle({ author_missions: authorMissions, ...row }) {
  return { ...row, author_title: titleFor(authorMissions) };
}

function visiblePost(post) {
  const { cursor_time: _, ...rest } = withAuthorTitle(post);
  if (!rest.hidden) {
    const { hidden_reason: __, ...visible } = rest;
    return visible;
  }
  return {
    ...rest,
    hidden_reason_label: reasonLabel(rest.hidden_reason),
    hidden_message: hiddenMessage(rest.hidden_reason)
  };
}

router.get('/:slug/posts', auth, async (req, res) => {
  const userId = req.user.userId;
  let cursor = null;
  if (req.query.cursor !== undefined) {
    cursor = decodeCursor(req.query.cursor);
    if (!cursor) return res.status(400).json({ error: FEED_CURSOR_MESSAGE, code: 'invalid_cursor' });
  }
  try {
    const commRes = await db.query('SELECT id, slug FROM communities WHERE slug = $1', [req.params.slug]);
    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });

    const continuous = await loadDayDone(userId);
    const pageSize = continuous ? CONTINUOUS_PAGE_SIZE : PAGE_SIZE;
    const postsRes = await db.query(
      `SELECT cp.id, cp.community_id, cp.user_id, cp.content, cp.created_at,
              cp.created_at::text AS cursor_time, u.username,
              (to_jsonb(cp) ->> 'hidden_at') IS NOT NULL AS hidden,
              CASE WHEN cp.user_id = $2 THEN to_jsonb(cp) ->> 'hidden_reason' END AS hidden_reason,
              (SELECT COUNT(*)::int FROM community_post_supports s WHERE s.post_id = cp.id) AS supports,
              EXISTS (
                SELECT 1 FROM community_post_supports s2
                WHERE s2.post_id = cp.id AND s2.user_id = $2
              ) AS supported_by_me,
              ${meritCountSql('cp.user_id')} AS author_missions
       FROM community_posts cp
       JOIN users u ON cp.user_id = u.id
       WHERE cp.community_id = $1
         AND ((to_jsonb(cp) ->> 'hidden_at') IS NULL OR cp.user_id = $2)
         AND ($3::timestamp IS NULL OR (cp.created_at, cp.id) < ($3::timestamp, $4::int))
       ORDER BY cp.created_at DESC, cp.id DESC
       LIMIT $5`,
      [community.id, userId, cursor ? cursor.createdAt : null, cursor ? cursor.id : null, pageSize + 1]
    );
    const rows = postsRes.rows.slice(0, pageSize);
    const last = rows[rows.length - 1];
    const nextCursor = postsRes.rows.length > pageSize && last ? encodeCursor(last.cursor_time, last.id) : null;
    res.json({
      posts: rows.map(visiblePost),
      next_cursor: nextCursor,
      page_size: pageSize,
      continuous_scroll: continuous,
      scroll_hint: continuous ? null : FEED_SCROLL_HINT
    });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: FEED_UNAVAILABLE_MESSAGE, code: 'unavailable' });
    res.status(500).json({ error: SUPPORT_SERVER_ERROR_MESSAGE });
  }
});

router.get('/:slug/highlights', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const commRes = await db.query('SELECT id, slug FROM communities WHERE slug = $1', [req.params.slug]);
    const community = commRes.rows[0];
    if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });
    // Post escondido não entra, nem para o autor. Só apoios dos últimos 7 dias.
    const result = await db.query(
      `SELECT cp.id, cp.community_id, cp.user_id, cp.content, cp.created_at, u.username,
              COUNT(s.id)::int AS week_supports,
              (SELECT COUNT(*)::int FROM community_post_supports s3 WHERE s3.post_id = cp.id) AS supports,
              EXISTS (
                SELECT 1 FROM community_post_supports s2
                WHERE s2.post_id = cp.id AND s2.user_id = $2
              ) AS supported_by_me,
              ${meritCountSql('cp.user_id')} AS author_missions
       FROM community_posts cp
       JOIN users u ON cp.user_id = u.id
       JOIN community_post_supports s
         ON s.post_id = cp.id AND s.created_at > NOW() - ($3::int * INTERVAL '1 day')
       WHERE cp.community_id = $1
         AND (to_jsonb(cp) ->> 'hidden_at') IS NULL
       GROUP BY cp.id, u.username
       ORDER BY week_supports DESC, cp.created_at DESC, cp.id DESC
       LIMIT $4`,
      [community.id, userId, HIGHLIGHTS_DAYS, HIGHLIGHTS_MAX]
    );
    res.json({ highlights: result.rows.map(withAuthorTitle), days: HIGHLIGHTS_DAYS, max: HIGHLIGHTS_MAX });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: FEED_UNAVAILABLE_MESSAGE, code: 'unavailable' });
    res.status(500).json({ error: SUPPORT_SERVER_ERROR_MESSAGE });
  }
});

// Post que pode receber apoio: existe, é desta comunidade e não está escondido.
async function supportTarget(req, res) {
  const postId = parsePostId(req.params.postId);
  if (!postId) {
    res.status(404).json({ error: REPORT_POST_NOT_FOUND_MESSAGE });
    return null;
  }
  const commRes = await db.query('SELECT id, slug FROM communities WHERE slug = $1', [req.params.slug]);
  const community = commRes.rows[0];
  if (!community) {
    res.status(404).json({ error: 'Comunidade não encontrada.' });
    return null;
  }
  if (isReadOnlyCommunity(community.slug)) {
    res.status(403).json({ error: READ_ONLY_MESSAGE, code: 'read_only' });
    return null;
  }
  const postRes = await db.query(
    `SELECT cp.id, cp.user_id, (to_jsonb(cp) ->> 'hidden_at') IS NOT NULL AS hidden
     FROM community_posts cp
     WHERE cp.id = $1 AND cp.community_id = $2`,
    [postId, community.id]
  );
  const post = postRes.rows[0];
  if (!post || post.hidden) {
    res.status(404).json({ error: REPORT_POST_NOT_FOUND_MESSAGE });
    return null;
  }
  return post;
}

async function supportTotal(postId) {
  const result = await db.query(
    'SELECT COUNT(*)::int AS total FROM community_post_supports WHERE post_id = $1',
    [postId]
  );
  return Number(result.rows[0]?.total) || 0;
}

router.post('/:slug/posts/:postId/support', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const post = await supportTarget(req, res);
    if (!post) return;
    if (Number(post.user_id) === Number(userId)) {
      return res.status(403).json({ error: SUPPORT_OWN_POST_MESSAGE, code: 'own_post' });
    }
    // UNIQUE (post_id, user_id): dois pedidos ao mesmo tempo gravam um só.
    const inserted = await db.query(
      `INSERT INTO community_post_supports (post_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (post_id, user_id) DO NOTHING
       RETURNING id`,
      [post.id, userId]
    );
    const supports = await supportTotal(post.id);
    if (inserted.rowCount !== 1) {
      return res.status(409).json({ error: SUPPORT_DUPLICATE_MESSAGE, code: 'already_supported', supported: true, supports });
    }
    res.status(201).json({ supported: true, supports });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: SUPPORT_UNAVAILABLE_MESSAGE, code: 'unavailable' });
    res.status(500).json({ error: SUPPORT_SERVER_ERROR_MESSAGE });
  }
});

router.delete('/:slug/posts/:postId/support', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const post = await supportTarget(req, res);
    if (!post) return;
    const removed = await db.query(
      'DELETE FROM community_post_supports WHERE post_id = $1 AND user_id = $2 RETURNING id',
      [post.id, userId]
    );
    const supports = await supportTotal(post.id);
    res.json({ supported: false, removed: removed.rowCount === 1, supports });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: SUPPORT_UNAVAILABLE_MESSAGE, code: 'unavailable' });
    res.status(500).json({ error: SUPPORT_SERVER_ERROR_MESSAGE });
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

    // Adicionar membro. Se a pessoa já era membro, o ON CONFLICT não grava
    // nada (rowCount 0) e o contador não sobe. A chave única
    // (community_id, user_id) garante isso mesmo com dois pedidos ao mesmo tempo.
    const memberInsert = await db.query(
      `INSERT INTO community_members (community_id, user_id, rank, missions_done)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_id, user_id) DO NOTHING
       RETURNING id`,
      [community.id, userId, rank, missionsDone]
    );
    const joinedNow = memberInsert.rowCount === 1;

    if (joinedNow) {
      await db.query(
        'UPDATE communities SET member_count = member_count + 1 WHERE id = $1',
        [community.id]
      );
    }

    res.json({
      success: true,
      already_member: !joinedNow,
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
//
// Ordem: filtro de crise → texto válido e até 280 caracteres → 18+
// confirmado → comunidade → membro → missão ATIVA da mesma área (decisão
// de 26/11; antes era 1 missão concluída na categoria) → limite de posts
// por pessoa em 24 horas → grava.
// ============================================
router.post('/:slug/posts', auth, async (req, res) => {
  const userId = req.user.userId;
  const content = req.body?.content;

  // Filtro de crise antes de tudo, o mesmo do check-in. Se dispara, o post
  // não é gravado, o texto não vai para log nem para a IA, e a resposta
  // leva crisis + crisis_level para o site abrir a tela de ajuda.
  const crisisLevel = typeof content === 'string' ? classifyNote(content) : null;
  if (crisisLevel) {
    return res.status(200).json({
      posted: false,
      crisis: true,
      crisis_level: crisisLevel,
      message: POST_CRISIS_MESSAGE
    });
  }

  if (content != null && typeof content !== 'string') {
    return res.status(400).json({ error: POST_NOT_TEXT_MESSAGE });
  }
  const text = (content || '').trim();
  if (!text) {
    return res.status(400).json({ error: POST_EMPTY_MESSAGE });
  }
  if (noteLength(text) > POST_MAX_CHARS) {
    return res.status(400).json({ error: POST_TOO_LONG_MESSAGE });
  }

  let client;
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
      return res.status(403).json({ error: POST_NOT_MEMBER_MESSAGE });
    }

    // Missão ativa da mesma área. Antes da 013: 503 calmo, nada gravado.
    const post = await checkPostAccess(userId, community);
    if (post.unavailable) {
      return res.status(503).json({ error: POST_AREAS_UNAVAILABLE_MESSAGE, code: 'unavailable' });
    }
    if (!post.ok) {
      return res.status(403).json({
        error: post.message,
        code: post.code,
        locked: true,
        community_area: community.area || null
      });
    }

    // Limite de posts: contar e gravar na mesma transação, com a linha da
    // pessoa travada, para dois pedidos ao mesmo tempo não passarem do limite.
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const countRes = await client.query(
      `SELECT COUNT(*) AS total FROM community_posts
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    if (parseInt(countRes.rows[0].total) >= POSTS_PER_DAY) {
      await client.query('ROLLBACK');
      return res.status(429).json({
        error: POST_RATE_LIMIT_MESSAGE,
        limit: POSTS_PER_DAY
      });
    }

    const result = await client.query(
      `INSERT INTO community_posts (community_id, user_id, content)
       VALUES ($1, $2, $3) RETURNING *`,
      [community.id, userId, text]
    );
    await client.query('COMMIT');

    res.status(201).json({ post: result.rows[0] });

  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    // Sem log do erro aqui: nada do pedido (nem o texto do post) vai para o console.
    res.status(500).json({ error: POST_SERVER_ERROR_MESSAGE });
  } finally {
    if (client) client.release();
  }
});

// ============================================
// DENUNCIAR UM POST
// POST /api/communities/:slug/posts/:postId/report
// Body: { reason, details? }
//
// Ordem: filtro de crise no comentário → id e motivo válidos → comentário até
// 280 caracteres → 18+ confirmado → comunidade → membro → (transação, com o post travado)
// post desta comunidade → não é o autor → uma vez por pessoa → conta as
// denúncias desde a última restauração → esconde com 3 pessoas, ou já na
// 1.ª denúncia "perigoso" (lib/post-reports.js, shouldHide).
//
// Crise no comentário: a denúncia vale (o post pode ser perigoso), mas o
// comentário não é gravado nem logado, e a resposta leva crisis + crisis_level.
// Se a denúncia for recusada por outro motivo, a pessoa vê a ajuda do mesmo jeito.
// ============================================
router.post('/:slug/posts/:postId/report', auth, async (req, res) => {
  const userId = req.user.userId;
  const { reason, details } = req.body || {};

  const crisisLevel = typeof details === 'string' ? classifyNote(details) : null;
  const refuse = (status, payload) => {
    if (crisisLevel) {
      return res.status(200).json({
        reported: false,
        crisis: true,
        crisis_level: crisisLevel,
        message: REPORT_CRISIS_NOT_SENT_MESSAGE
      });
    }
    return res.status(status).json(payload);
  };

  const postId = parsePostId(req.params.postId);
  if (!postId) return refuse(404, { error: REPORT_POST_NOT_FOUND_MESSAGE });
  if (!isValidReason(reason)) return refuse(400, { error: REPORT_REASON_MESSAGE });

  let cleanDetails = null;
  if (!crisisLevel && details != null) {
    if (typeof details !== 'string') return refuse(400, { error: REPORT_DETAILS_NOT_TEXT_MESSAGE });
    const text = details.trim();
    if (noteLength(text) > NOTE_MAX_CHARS) {
      return refuse(400, { error: REPORT_DETAILS_TOO_LONG_MESSAGE });
    }
    cleanDetails = text || null;
  }

  let client;
  try {
    // O portão 18+ já barrou antes; esta conferência é uma segunda trava
    // antes de gravar a denúncia.
    if (!(await hasAdultConfirmation(userId))) {
      return refuse(403, adultRequiredBody());
    }

    const commRes = await db.query(
      'SELECT * FROM communities WHERE slug = $1',
      [req.params.slug]
    );
    const community = commRes.rows[0];
    if (!community) return refuse(404, { error: 'Comunidade não encontrada.' });

    const memberRes = await db.query(
      'SELECT * FROM community_members WHERE community_id = $1 AND user_id = $2',
      [community.id, userId]
    );
    if (!memberRes.rows[0]) return refuse(403, { error: REPORT_NOT_MEMBER_MESSAGE });

    client = await db.connect();
    await client.query('BEGIN');

    // Trava a pessoa primeiro (a cota de "perigoso" não passa de 3 com
    // pedidos ao mesmo tempo) e depois o post. Sempre nessa ordem, como na
    // rota de posts, que só trava a pessoa.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    // Trava o post: duas denúncias ao mesmo tempo não passam do número
    // sem esconder, nem escondem duas vezes.
    const postRes = await client.query(
      `SELECT id, user_id, hidden_at, restored_at
       FROM community_posts
       WHERE id = $1 AND community_id = $2
       FOR UPDATE`,
      [postId, community.id]
    );
    const post = postRes.rows[0];
    if (!post) {
      await client.query('ROLLBACK');
      return refuse(404, { error: REPORT_POST_NOT_FOUND_MESSAGE });
    }
    if (post.user_id === userId) {
      await client.query('ROLLBACK');
      return refuse(400, { error: REPORT_OWN_POST_MESSAGE });
    }

    // "perigoso" esconde sozinho só dentro da cota de 3 por pessoa em 24
    // horas. Fora da cota, a denúncia vale como comum (entra nas 3 pessoas).
    let fastTrack = false;
    if (reason === URGENT_REASON) {
      const quotaRes = await client.query(
        `SELECT COUNT(*) AS total
         FROM community_post_reports
         WHERE reporter_id = $1
           AND fast_track = true
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [userId]
      );
      fastTrack = parseInt(quotaRes.rows[0].total) < FAST_TRACK_PER_DAY;
    }

    const insertRes = await client.query(
      `INSERT INTO community_post_reports (post_id, reporter_id, reason, details, fast_track)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (post_id, reporter_id) DO NOTHING
       RETURNING id`,
      [postId, userId, reason, cleanDetails, fastTrack]
    );
    if (insertRes.rowCount !== 1) {
      await client.query('ROLLBACK');
      return refuse(409, { error: REPORT_DUPLICATE_MESSAGE, already_reported: true });
    }

    if (!post.hidden_at) {
      const since = post.restored_at || null;
      const countRes = await client.query(
        `SELECT reason, fast_track, COUNT(*) AS total
         FROM community_post_reports
         WHERE post_id = $1
           AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
         GROUP BY reason, fast_track`,
        [postId, since]
      );
      if (shouldHide(countRes.rows)) {
        await client.query(
          `UPDATE community_posts
           SET hidden_at = NOW(), hidden_reason = $2
           WHERE id = $1 AND hidden_at IS NULL`,
          [postId, pickHiddenReason(countRes.rows)]
        );
        // Marca as denúncias que contaram, para o alerta do admin.
        await client.query(
          `UPDATE community_post_reports
           SET hid_post_at = NOW()
           WHERE post_id = $1
             AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)`,
          [postId, since]
        );
      }
    }

    await client.query('COMMIT');

    if (crisisLevel) {
      return res.status(201).json({
        reported: true,
        crisis: true,
        crisis_level: crisisLevel,
        message: REPORT_CRISIS_SAVED_MESSAGE
      });
    }
    res.status(201).json({ reported: true, message: REPORT_DONE_MESSAGE });

  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    // Sem log: nada do pedido (nem o comentário) vai para o console.
    if (isMissingSchema(err)) return refuse(503, { error: REPORT_UNAVAILABLE_MESSAGE });
    refuse(500, { error: REPORT_SERVER_ERROR_MESSAGE });
  } finally {
    if (client) client.release();
  }
});

// ============================================
// CRIAR COMUNIDADE
// POST /api/communities
// Body: { name, area, category (o assunto, opcional), description (as regras,
//         opcional), icon, cover_color }
//
// Ordem: filtro de crise no nome, no assunto e nas regras (o portão 18+ já
// mostra a ajuda antes, até para quem não tem 18+) → textos válidos → área →
// 1 missão de 30 dias CONCLUÍDA (dono ou parceiro do Duo; antes eram 3
// missões de qualquer tamanho) → limite de 1 por semana, com a linha da
// pessoa travada → grava. Antes da 013 (sem communities.area): 503 calmo.
// ============================================
router.post('/', auth, async (req, res) => {
  const { area, icon, cover_color } = req.body || {};
  const userId = req.user.userId;

  const name = optionalText(req.body?.name);
  const topic = optionalText(req.body?.category);
  const description = optionalText(req.body?.description);

  // Crise primeiro: nada é gravado e o texto não vai para log nem para o banco.
  for (const field of [req.body?.name, req.body?.category, req.body?.description, icon]) {
    const level = typeof field === 'string' ? classifyNote(field) : null;
    if (level) {
      return res.status(200).json({
        saved: false,
        crisis: true,
        crisis_level: level,
        message: CREATE_CRISIS_MESSAGE
      });
    }
  }

  if (!name.ok || !topic.ok || !description.ok) {
    return res.status(400).json({ error: CREATE_TEXT_MESSAGE, code: 'invalid_text' });
  }
  if (!name.value || Array.from(name.value).length > CREATE_NAME_MAX) {
    return res.status(400).json({ error: CREATE_NAME_MESSAGE, code: 'invalid_name' });
  }
  const slug = slugOf(name.value);
  if (slug.length < 2) {
    return res.status(400).json({ error: CREATE_NAME_LETTERS_MESSAGE, code: 'invalid_name' });
  }
  if (!isValidArea(area)) {
    return res.status(400).json({ error: AREA_INVALID_MESSAGE, code: 'invalid_area' });
  }
  if (topic.value && Array.from(topic.value).length > CREATE_TOPIC_MAX) {
    return res.status(400).json({ error: CREATE_TOPIC_MESSAGE, code: 'invalid_topic' });
  }
  if (description.value && Array.from(description.value).length > CREATE_DESCRIPTION_MAX) {
    return res.status(400).json({ error: CREATE_DESCRIPTION_MESSAGE, code: 'invalid_description' });
  }
  // Ícone: opcional; se vier, só emoji (nada de palavra livre).
  if (icon !== undefined && icon !== null && icon !== '' && !isEmojiIcon(icon)) {
    return res.status(400).json({ error: CREATE_ICON_MESSAGE, code: 'invalid_icon' });
  }
  if (CREATE_RESERVED_SLUGS.includes(slug)) {
    return res.status(409).json({ error: CREATE_DUPLICATE_MESSAGE, code: 'name_taken' });
  }

  let client;
  try {
    // Só missão pessoal (tabela missions) de 30 dias ou mais, concluída.
    const doneRes = await db.query(
      `SELECT COUNT(*) AS total FROM missions
       WHERE (user_id = $1 OR partner_id = $1)
         AND status = 'completed'
         AND duration_days >= $2`,
      [userId, CREATE_MIN_DAYS]
    );
    const done = parseInt(doneRes.rows[0].total, 10) || 0;
    if (done < 1) {
      return res.status(403).json({
        error: CREATE_LOCKED_MESSAGE,
        code: 'needs_completed_mission',
        locked: true,
        missions_done: 0,
        needed: 1
      });
    }

    // Limite e gravação na mesma transação, com a linha da pessoa travada:
    // dois pedidos ao mesmo tempo não criam duas.
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const recentRes = await client.query(
      `SELECT COUNT(*) AS total FROM communities
       WHERE created_by = $1
         AND created_at > NOW() - INTERVAL '7 days'`,
      [userId]
    );
    if (parseInt(recentRes.rows[0].total, 10) >= CREATE_PER_WEEK) {
      await client.query('ROLLBACK');
      return res.status(429).json({ error: CREATE_RATE_LIMIT_MESSAGE, code: 'create_limit', limit: CREATE_PER_WEEK });
    }

    const result = await client.query(
      `INSERT INTO communities (name, slug, description, category, area, icon, cover_color, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name.value, slug, description.value, topic.value || area, area,
        isEmojiIcon(icon) ? icon : '⚡',
        typeof cover_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(cover_color) ? cover_color : '#FF5C00',
        userId]
    );
    await client.query('COMMIT');

    res.status(201).json({
      community: result.rows[0],
      message: 'Comunidade criada.'
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    if (err && err.code === '23505') {
      return res.status(409).json({ error: CREATE_DUPLICATE_MESSAGE, code: 'name_taken' });
    }
    if (isMissingSchema(err)) {
      return res.status(503).json({ error: CREATE_UNAVAILABLE_MESSAGE, code: 'unavailable' });
    }
    // Sem log: nada do pedido vai para o console.
    res.status(500).json({ error: CREATE_SERVER_ERROR_MESSAGE });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
