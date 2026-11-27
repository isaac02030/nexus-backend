// ============================================
// NEXUS — Maratona da comunidade (PR E; refeita)
//
// Decisão de 26/11 (mérito e Maratona) e plano do Vitrúvio (PR E):
// - Um membro cria a Maratona na comunidade (mesma regra de "voz" do post:
//   membro + missão ATIVA da mesma área + comunidade que não é só leitura).
// - O grupo entra e registra o dia. O progresso é do GRUPO: sem ranking
//   individual no beta.
// - O dia é o de Lisboa (relógio do banco, Europe/Lisbon), não UTC.
// - Check-ins na tabela própria (migração 017), nunca em checkins (essa é a
//   das missões pessoais; o código antigo gravava lá: bug corrigido).
// - A Maratona não conta para o título (lib/merit só lê missions).
// - Pontos e moedas: só no PR F (gancho onMarathonDayDone, sem efeito).
// - Filtro de crise no título e no mínimo do dia; 18+ em tudo.
//
// Os modos antigos (solo e duo dentro da comunidade) saíram: só a Maratona.
// As rotas antigas de ranking individual e de "scope" respondem 410.
// Antes da 017: 503 calmo.
// ============================================

const express  = require('express');
const { db } = require('../lib/db');
const auth     = require('../middleware/auth');
const { makeAdultGate } = require('../lib/adult-gate');
const { classifyNote } = require('../lib/crisis-filter');
const { postAccess, isReadOnlyCommunity, READ_ONLY_MESSAGE } = require('../lib/community-access');
const { ownOrDuoMissionSql } = require('../lib/mission-participation');
const router   = express.Router();

// Portão 18+ (lib/adult-gate.js): todas as rotas deste arquivo exigem login
// e 18+ confirmado. Sem a confirmação: 403 com code adult_confirmation_required.
const { gate: adultGate } = makeAdultGate(db);
router.use(adultGate);

const TIME_ZONE = 'Europe/Lisbon';
const MIN_DAYS = 3;
const MAX_DAYS = 30;
const MIN_PEOPLE = 2;
const MAX_PEOPLE = 100;
const MAX_START_AHEAD_DAYS = 14;
const TITLE_MAX = 60;
const MINIMUM_MAX = 140;

// Textos novos (para o sim do dono do projeto).
const T = {
  crisis: 'A maratona não foi criada. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.',
  title: `Dê um nome à maratona, com até ${TITLE_MAX} caracteres.`,
  minimum: `Escreva o mínimo de cada dia, com até ${MINIMUM_MAX} caracteres.`,
  text: 'O nome e o mínimo do dia precisam ser texto. Escreva de novo e envie.',
  days: `A maratona dura de ${MIN_DAYS} a ${MAX_DAYS} dias.`,
  people: `A maratona aceita de ${MIN_PEOPLE} a ${MAX_PEOPLE} pessoas.`,
  start: `Escolha um dia de início entre hoje e daqui a ${MAX_START_AHEAD_DAYS} dias.`,
  notMemberCreate: 'Entre na comunidade para criar uma maratona.',
  notMemberJoin: 'Entre na comunidade para participar da maratona.',
  notFound: 'Maratona não encontrada.',
  communityNotFound: 'Comunidade não encontrada.',
  ended: 'Esta maratona já terminou.',
  full: 'Esta maratona já está cheia.',
  notParticipant: 'Entre na maratona para registrar o dia.',
  notStarted: 'A maratona ainda não começou. O registro abre no primeiro dia.',
  alreadyDone: 'Você já registrou o dia de hoje na maratona.',
  done: 'Dia registrado na maratona.',
  created: 'Maratona criada.',
  joined: 'Você entrou na maratona.',
  unavailable: 'A maratona ainda não está disponível. Tente de novo mais tarde.',
  server: 'Não deu para concluir agora. Tente de novo daqui a pouco.',
  gone: 'Esta rota foi desativada. Use a Maratona da comunidade.'
};

function isMissingSchema(err) {
  return err && (err.code === '42703' || err.code === '42P01');
}

function fail(res, err) {
  if (isMissingSchema(err)) return res.status(503).json({ error: T.unavailable, code: 'unavailable' });
  // Sem log: nada do pedido vai para o console.
  return res.status(500).json({ error: T.server });
}

function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return id <= 2147483647 ? id : null;
}

// Só número de verdade (não texto), inteiro e dentro dos limites.
function intIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function cleanText(value) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false };
  return { ok: true, value: value.replace(/\s+/g, ' ').trim() };
}

// "Hoje" e o dia da maratona sempre pelo relógio do banco, em Lisboa.
const TODAY_SQL = `(NOW() AT TIME ZONE '${TIME_ZONE}')::date`;

// Gancho do PR F (pontos e moedas): de propósito, não faz nada agora.
// Quando o PR F entrar, ele grava aqui um lançamento no ledger (uma linha
// por pessoa, maratona e dia, com UNIQUE), dentro da mesma transação.
async function onMarathonDayDone(_client, _event) {
  return null;
}

async function findCommunity(slug, userId) {
  const result = await db.query(
    `SELECT c.id, c.slug, c.name, to_jsonb(c) ->> 'area' AS area,
            EXISTS (
              SELECT 1 FROM community_members m
              WHERE m.community_id = c.id AND m.user_id = $2
            ) AS is_member
     FROM communities c
     WHERE c.slug = $1`,
    [slug, userId]
  );
  return result.rows[0] || null;
}

// Quem pode criar: a mesma regra do post (lib/community-access): missão
// ATIVA da área da comunidade (dono ou parceiro do Duo de verdade).
async function createAccess(userId, community) {
  if (isReadOnlyCommunity(community.slug)) {
    return { ok: false, code: 'read_only', message: READ_ONLY_MESSAGE };
  }
  const areas = await db.query(
    `SELECT m.area FROM missions m
     WHERE ${ownOrDuoMissionSql('$1', 'm')}
       AND m.status = 'active'`,
    [userId]
  );
  return postAccess(areas.rows.map((r) => (r.area == null ? null : r.area)), community.area);
}

// Uma maratona desta comunidade, com as datas em Lisboa já calculadas.
async function findMarathon(missionId, communityId, userId, executor = db, lock = false) {
  const result = await executor.query(
    `SELECT cm.id, cm.title, cm.description, cm.duration_days, cm.max_participants,
            cm.start_day, (cm.start_day + cm.duration_days - 1) AS end_day,
            ${TODAY_SQL} AS today,
            (${TODAY_SQL} - cm.start_day + 1)::int AS day_number,
            EXISTS (
              SELECT 1 FROM community_mission_participants p
              WHERE p.community_mission_id = cm.id AND p.user_id = $3
            ) AS is_participant
     FROM community_missions cm
     WHERE cm.id = $1 AND cm.community_id = $2
       AND cm.mode = 'maratona' AND cm.start_day IS NOT NULL
     ${lock ? 'FOR UPDATE OF cm' : ''}`,
    [missionId, communityId, userId]
  );
  return result.rows[0] || null;
}

function phase(m) {
  const day = Number(m.day_number);
  if (day < 1) return 'upcoming';
  if (day > Number(m.duration_days)) return 'ended';
  return 'active';
}

// ============================================
// LISTAR AS MARATONAS DA COMUNIDADE (as que não terminaram)
// GET /api/community-missions/:slug
// ============================================
router.get('/:slug', auth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const community = await findCommunity(req.params.slug, userId);
    if (!community) return res.status(404).json({ error: T.communityNotFound });
    const result = await db.query(
      `SELECT cm.id, cm.title, cm.description, cm.duration_days, cm.max_participants,
              to_char(cm.start_day, 'YYYY-MM-DD') AS start_day,
              (${TODAY_SQL} - cm.start_day + 1)::int AS day_number,
              (SELECT COUNT(*)::int FROM community_mission_participants p
               WHERE p.community_mission_id = cm.id) AS participants,
              EXISTS (
                SELECT 1 FROM community_mission_participants p2
                WHERE p2.community_mission_id = cm.id AND p2.user_id = $2
              ) AS is_participant
       FROM community_missions cm
       WHERE cm.community_id = $1
         AND cm.mode = 'maratona' AND cm.start_day IS NOT NULL
         AND cm.start_day + cm.duration_days - 1 >= ${TODAY_SQL}
       ORDER BY cm.start_day ASC, cm.id ASC`,
      [community.id, userId]
    );
    res.json({
      marathons: result.rows.map((m) => ({ ...m, phase: phase(m) })),
      can_create: community.is_member ? (await createAccess(userId, community)).ok : false
    });
  } catch (err) {
    fail(res, err);
  }
});

// ============================================
// CRIAR UMA MARATONA
// POST /api/community-missions/:slug
// Body: { title, description (o mínimo de cada dia), duration_days,
//         max_participants, start_day ('AAAA-MM-DD', em Lisboa) }
// ============================================
router.post('/:slug', auth, async (req, res) => {
  const userId = req.user.userId;
  const body = req.body || {};

  // Crise primeiro: nada é gravado; o texto não vai para o banco nem para o log.
  for (const field of [body.title, body.description]) {
    const level = typeof field === 'string' ? classifyNote(field) : null;
    if (level) {
      return res.status(200).json({ saved: false, crisis: true, crisis_level: level, message: T.crisis });
    }
  }
  const title = cleanText(body.title);
  const minimum = cleanText(body.description);
  if (!title.ok || !minimum.ok) return res.status(400).json({ error: T.text, code: 'invalid_text' });
  if (!title.value || Array.from(title.value).length > TITLE_MAX) {
    return res.status(400).json({ error: T.title, code: 'invalid_title' });
  }
  if (!minimum.value || Array.from(minimum.value).length > MINIMUM_MAX) {
    return res.status(400).json({ error: T.minimum, code: 'invalid_minimum' });
  }
  const days = intIn(body.duration_days, MIN_DAYS, MAX_DAYS);
  if (!days) return res.status(400).json({ error: T.days, code: 'invalid_days' });
  const people = body.max_participants == null ? MAX_PEOPLE : intIn(body.max_participants, MIN_PEOPLE, MAX_PEOPLE);
  if (!people) return res.status(400).json({ error: T.people, code: 'invalid_people' });
  if (body.start_day != null && (typeof body.start_day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.start_day))) {
    return res.status(400).json({ error: T.start, code: 'invalid_start' });
  }

  try {
    const community = await findCommunity(req.params.slug, userId);
    if (!community) return res.status(404).json({ error: T.communityNotFound });
    if (!community.is_member) return res.status(403).json({ error: T.notMemberCreate, code: 'not_member' });
    const access = await createAccess(userId, community);
    if (!access.ok) return res.status(403).json({ error: access.message, code: access.code, locked: true });

    // O início entra como data de Lisboa e é conferido pelo relógio do banco.
    const result = await db.query(
      `INSERT INTO community_missions
         (community_id, title, description, mode, scope, duration_days, max_participants,
          created_by, start_day, starts_at, ends_at, status)
       SELECT $1, $2, $3, 'maratona', 'comunidade', $4, $5, $6, d.day,
              (d.day::timestamp AT TIME ZONE '${TIME_ZONE}'),
              ((d.day + $4::int)::timestamp AT TIME ZONE '${TIME_ZONE}'),
              'open'
       FROM (SELECT COALESCE($7::date, ${TODAY_SQL}) AS day) d
       WHERE d.day BETWEEN ${TODAY_SQL} AND ${TODAY_SQL} + ${MAX_START_AHEAD_DAYS}
       RETURNING id, title, description, duration_days, max_participants,
                 to_char(start_day, 'YYYY-MM-DD') AS start_day`,
      [community.id, title.value, minimum.value, days, people, userId, body.start_day || null]
    );
    if (!result.rows[0]) return res.status(400).json({ error: T.start, code: 'invalid_start' });

    // Quem cria entra.
    await db.query(
      `INSERT INTO community_mission_participants (community_mission_id, user_id)
       VALUES ($1, $2) ON CONFLICT (community_mission_id, user_id) DO NOTHING`,
      [result.rows[0].id, userId]
    );
    res.status(201).json({ marathon: result.rows[0], message: T.created });
  } catch (err) {
    if (err && err.code === '22008') return res.status(400).json({ error: T.start, code: 'invalid_start' });
    fail(res, err);
  }
});

// ============================================
// RANKING INDIVIDUAL E "SCOPE" ANTIGOS: desativados (410)
// A Maratona do beta não tem ranking individual (decisão de 26/11).
// Ficam antes de /:slug/:missionId para não serem confundidos com ela.
// ============================================
router.get('/:slug/:missionId/ranking', auth, (req, res) => {
  res.status(410).json({ error: T.gone, code: 'gone' });
});

router.get('/:slug/scope/:scope', auth, (req, res) => {
  res.status(410).json({ error: T.gone, code: 'gone' });
});

// ============================================
// VER UMA MARATONA: o progresso do GRUPO
// GET /api/community-missions/:slug/:missionId
// Ler é aberto (18+), como a comunidade. Sem nomes e sem ranking.
// ============================================
router.get('/:slug/:missionId', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = parseId(req.params.missionId);
  if (!missionId) return res.status(404).json({ error: T.notFound });
  try {
    const community = await findCommunity(req.params.slug, userId);
    if (!community) return res.status(404).json({ error: T.notFound });
    const m = await findMarathon(missionId, community.id, userId);
    if (!m) return res.status(404).json({ error: T.notFound });

    const counts = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM community_mission_participants p WHERE p.community_mission_id = $1) AS participants,
         COALESCE((
           SELECT json_agg(json_build_object('day', d.day_number, 'done', d.done) ORDER BY d.day_number)
           FROM (
             SELECT k.day_number, COUNT(*)::int AS done
             FROM community_marathon_checkins k
             WHERE k.community_mission_id = $1
             GROUP BY k.day_number
           ) d
         ), '[]'::json) AS days,
         EXISTS (
           SELECT 1 FROM community_marathon_checkins k2
           WHERE k2.community_mission_id = $1 AND k2.user_id = $2 AND k2.day_date = ${TODAY_SQL}
         ) AS my_day_done`,
      [m.id, userId]
    );
    const row = counts.rows[0];
    const p = phase(m);
    const today = (row.days || []).find((d) => Number(d.day) === Number(m.day_number));
    res.json({
      marathon: {
        id: m.id,
        title: m.title,
        description: m.description,
        duration_days: Number(m.duration_days),
        max_participants: Number(m.max_participants),
        phase: p,
        day: p === 'active' ? Number(m.day_number) : null,
        starts_in_days: p === 'upcoming' ? 1 - Number(m.day_number) : null
      },
      group: {
        participants: Number(row.participants) || 0,
        today_done: p === 'active' && today ? Number(today.done) : 0,
        days: row.days || []
      },
      me: { is_participant: m.is_participant === true, day_done: row.my_day_done === true }
    });
  } catch (err) {
    fail(res, err);
  }
});

// ============================================
// ENTRAR NUMA MARATONA (só membro da comunidade)
// POST /api/community-missions/:slug/:missionId/join
// ============================================
router.post('/:slug/:missionId/join', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = parseId(req.params.missionId);
  if (!missionId) return res.status(404).json({ error: T.notFound });
  let client;
  try {
    const community = await findCommunity(req.params.slug, userId);
    if (!community) return res.status(404).json({ error: T.notFound });
    if (!community.is_member) return res.status(403).json({ error: T.notMemberJoin, code: 'not_member' });

    // A maratona travada: dois pedidos ao mesmo tempo não passam do limite.
    client = await db.connect();
    await client.query('BEGIN');
    const m = await findMarathon(missionId, community.id, userId, client, true);
    if (!m) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: T.notFound });
    }
    if (phase(m) === 'ended') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: T.ended, code: 'ended' });
    }
    if (m.is_participant) {
      await client.query('ROLLBACK');
      return res.json({ joined: true, already: true, message: T.joined });
    }
    const countRes = await client.query(
      'SELECT COUNT(*)::int AS total FROM community_mission_participants WHERE community_mission_id = $1',
      [m.id]
    );
    if (Number(countRes.rows[0].total) >= Number(m.max_participants)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: T.full, code: 'full' });
    }
    await client.query(
      `INSERT INTO community_mission_participants (community_mission_id, user_id)
       VALUES ($1, $2) ON CONFLICT (community_mission_id, user_id) DO NOTHING`,
      [m.id, userId]
    );
    await client.query('COMMIT');
    res.status(201).json({ joined: true, already: false, message: T.joined });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    fail(res, err);
  } finally {
    if (client) client.release();
  }
});

// ============================================
// REGISTRAR O DIA NA MARATONA
// POST /api/community-missions/:slug/:missionId/checkin
// Só participante, só dentro do período (em Lisboa), um por dia.
// Sem texto: nada para o filtro de crise guardar.
// ============================================
router.post('/:slug/:missionId/checkin', auth, async (req, res) => {
  const userId = req.user.userId;
  const missionId = parseId(req.params.missionId);
  if (!missionId) return res.status(404).json({ error: T.notFound });
  let client;
  try {
    const community = await findCommunity(req.params.slug, userId);
    if (!community) return res.status(404).json({ error: T.notFound });
    const m = await findMarathon(missionId, community.id, userId);
    if (!m) return res.status(404).json({ error: T.notFound });
    if (!m.is_participant) return res.status(403).json({ error: T.notParticipant, code: 'not_participant' });
    const p = phase(m);
    if (p === 'upcoming') return res.status(409).json({ error: T.notStarted, code: 'not_started' });
    if (p === 'ended') return res.status(409).json({ error: T.ended, code: 'ended' });

    client = await db.connect();
    await client.query('BEGIN');
    // UNIQUE (maratona, pessoa, dia): o segundo registro do dia não grava.
    const inserted = await client.query(
      `INSERT INTO community_marathon_checkins (community_mission_id, user_id, day_date, day_number)
       VALUES ($1, $2, ${TODAY_SQL}, $3)
       ON CONFLICT (community_mission_id, user_id, day_date) DO NOTHING
       RETURNING id`,
      [m.id, userId, Number(m.day_number)]
    );
    if (inserted.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: T.alreadyDone, code: 'already_done', day: Number(m.day_number) });
    }
    await onMarathonDayDone(client, { userId, marathonId: m.id, day: Number(m.day_number) });
    await client.query('COMMIT');
    res.status(201).json({ done: true, day: Number(m.day_number), message: T.done });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    fail(res, err);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
module.exports.onMarathonDayDone = onMarathonDayDone;
