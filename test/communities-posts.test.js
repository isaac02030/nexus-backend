const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');
const { ownOrDuoMissionSql } = require('../lib/mission-participation');
const RULE_TEXT = (who, alias) => String(ownOrDuoMissionSql(who, alias)).replace(/\s+/g, ' ').trim();

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const communitiesRouter = require('../routes/communities');
const communityMissionsRouter = require('../routes/community-missions');

const app = express();
app.use(express.json());
app.use('/api/communities', communitiesRouter);

// Banco simulado: só o necessário para comunidades, membros e posts.
const db = {
  communities: [],
  members: [],
  completedMissions: new Map(), // userId -> missões concluídas na categoria
  activeAreas: new Map(),       // userId -> áreas das missões ATIVAS (dono ou parceiro)
  missions: [],                 // para a recomendação: { id, user_id, partner_id, area, subject }
  recentPosts: new Map(),       // userId -> posts nas últimas 24 horas
  posts: [],
  queries: [],
  failInsert: false,
  before013: false,             // migração 013 não aplicada: sem colunas area/subject
  notAdult: new Set()
};

function resetDb() {
  db.communities = [
    { id: 3, slug: 'foco', name: 'Foco', category: 'estudo', member_count: 1, area: 'mente' },
    { id: 4, slug: 'sem-area', name: 'Antiga', category: 'estudo', member_count: 1, area: null },
    { id: 5, slug: 'idiomas', name: 'Idiomas', description: 'Inglês, espanhol e outras línguas', category: 'idiomas', member_count: 9, is_default: true, area: 'mente' },
    { id: 6, slug: 'psicologia', name: 'Psicologia', description: 'Leituras de psicologia e filosofia', category: 'estudo', member_count: 2, area: 'mente' },
    { id: 7, slug: 'corrida', name: 'Corrida', category: 'corrida', member_count: 30, is_default: true, area: 'corpo' },
    { id: 8, slug: 'alimentacao', name: 'Alimentação', category: 'alimentacao', member_count: 3, is_default: true, area: 'corpo' }
  ];
  db.members = [];
  db.completedMissions = new Map();
  db.activeAreas = new Map();
  db.missions = [];
  db.before013 = false;
  db.missionAreaMissing = false;
  db.recentPosts = new Map();
  db.posts = [];
  db.queries = [];
  db.failInsert = false;
  db.notAdult = new Set();
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };

  // 18+ confirmado no cadastro (todo mundo, menos quem está em notAdult).
  if (/adult_confirmed_at'\) IS NOT NULL AS adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !db.notAdult.has(Number(params[0])) }] };
  }

  if (/^INSERT INTO community_members/i.test(text)) {
    db.lastMemberInsert = params;
    const exists = db.members.some((m) =>
      m.community_id === Number(params[0]) && m.user_id === Number(params[1]));
    if (exists) return { rows: [], rowCount: 0 };
    db.members.push({ community_id: Number(params[0]), user_id: Number(params[1]) });
    return { rows: [{ id: db.members.length }], rowCount: 1 };
  }

  // Título ao entrar (lib/merit): missões que contam, por pessoa.
  if (/^SELECT \(SELECT COUNT\(\*\)::int FROM missions mm/.test(text) && /FROM users u WHERE u\.id = \$1$/.test(text)) {
    return { rows: [{ missions: db.completedMissions.get(Number(params[0])) || 0 }] };
  }

  if (/^UPDATE communities SET member_count/i.test(text)) {
    const c = db.communities.find((item) => item.id === Number(params[0]));
    if (c) c.member_count += 1;
    return { rows: [], rowCount: c ? 1 : 0 };
  }

  if (/^INSERT INTO community_posts/i.test(text)) {
    if (db.failInsert) throw new Error('falha simulada do banco');
    const row = {
      id: db.posts.length + 1,
      community_id: Number(params[0]),
      user_id: Number(params[1]),
      content: params[2]
    };
    db.posts.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }

  if (/FROM users WHERE id = \$1 FOR UPDATE/i.test(text)) {
    return { rows: [{ id: Number(params[0]) }] };
  }

  if (/FROM community_posts/i.test(text) && /24 hours/i.test(text)) {
    const total = (db.recentPosts.get(Number(params[0])) || 0)
      + db.posts.filter((p) => p.user_id === Number(params[0])).length;
    return { rows: [{ total: String(total) }] };
  }

  if (/^SELECT \* FROM communities WHERE slug = \$1/i.test(text)) {
    const c = db.communities.find((item) => item.slug === params[0]);
    if (!c) return { rows: [] };
    const row = { ...c };
    if (db.before013) delete row.area;
    return { rows: [row] };
  }

  const missingColumn = () => Object.assign(new Error('column "area" does not exist'), { code: '42703' });

  // Missões ativas da pessoa (dono ou parceiro): só a área.
  if (text === `SELECT m.area FROM missions m WHERE ${RULE_TEXT('$1', 'm')} AND m.status = 'active'`) {
    if (db.before013 || db.missionAreaMissing) throw missingColumn();
    return { rows: (db.activeAreas.get(Number(params[0])) || []).map((area) => ({ area })) };
  }

  // Recomendação: a missão da pessoa (dono ou parceiro).
  if (/^SELECT id, area, subject FROM missions WHERE id = \$1 AND \(user_id = \$2 OR partner_id = \$2\)$/i.test(text)) {
    if (db.before013) throw missingColumn();
    const m = db.missions.find((item) => item.id === Number(params[0])
      && (item.user_id === Number(params[1]) || item.partner_id === Number(params[1])));
    return { rows: m ? [{ id: m.id, area: m.area, subject: m.subject }] : [] };
  }

  if (/FROM communities c LEFT JOIN community_members cm ON cm\.community_id = c\.id AND cm\.user_id = \$1 WHERE c\.area = \$2$/i.test(text)) {
    return {
      rows: db.communities.filter((c) => c.area === params[1]).map((c) => ({
        ...c,
        is_member: db.members.some((m) => m.community_id === c.id && m.user_id === Number(params[0]))
      }))
    };
  }

  // Ver comunidade (GET /:slug).
  if (/^SELECT c\.\*, CASE WHEN cm\.user_id IS NOT NULL/i.test(text) && /WHERE c\.slug = \$2$/i.test(text)) {
    const c = db.communities.find((item) => item.slug === params[1]);
    if (!c) return { rows: [] };
    const row = { ...c, is_member: db.members.some((m) => m.community_id === c.id && m.user_id === Number(params[0])), missions_done: 0, total_days: 0 };
    if (db.before013) delete row.area;
    return { rows: [row] };
  }

  if (/FROM community_posts cp JOIN users u ON cp\.user_id = u\.id WHERE cp\.community_id = \$1/i.test(text)) {
    return {
      rows: db.posts.filter((p) => p.community_id === Number(params[0]))
        .map((p) => ({ ...p, username: `pessoa${p.user_id}`, hidden: false }))
    };
  }

  if (/FROM community_members WHERE community_id = \$1 AND user_id = \$2/i.test(text)) {
    const m = db.members.find((item) =>
      item.community_id === Number(params[0]) && item.user_id === Number(params[1]));
    return { rows: m ? [{ ...m }] : [] };
  }

  if (/SELECT COUNT\(\*\) as total FROM missions/i.test(text)) {
    return { rows: [{ total: String(db.completedMissions.get(Number(params[0])) || 0) }] };
  }

  if (/FROM communities c/i.test(text) && /c\.category = \$2/i.test(text)) {
    return { rows: [] };
  }

  if (/FROM missions WHERE id = \$1/i.test(text)) {
    return { rows: [] };
  }

  return { rows: [] };
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

function insertedPost() {
  return db.queries.some((q) => /^INSERT INTO community_posts/i.test(q.text));
}

function textReachedDb(fragment) {
  return db.queries.some((q) => q.params.some((p) => typeof p === 'string' && p.includes(fragment)));
}

// Membro da comunidade "foco" (área mente) com uma missão ATIVA de mente.
function makeMember(userId, { areas = ['mente'], recent = 0, communityId = 3 } = {}) {
  db.members.push({ community_id: communityId, user_id: userId });
  db.activeAreas.set(userId, areas);
  db.recentPosts.set(userId, recent);
}

let server;
let baseUrl;
const consoleCalls = [];

async function request(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { 'Content-Type': 'application/json' })
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : {} };
}

describe('comunidades: rotas, entrada e posts', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({
      query: async (sql, params) => handle(sql, params),
      release() {}
    }));
    for (const name of ['log', 'error', 'warn', 'info']) {
      mock.method(console, name, (...args) => { consoleCalls.push(args); });
    }
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetDb();
    consoleCalls.length = 0;
  });

  // ---------- T1: ordem e cópias das rotas ----------

  test('/suggest/:category responde pela própria rota, não por /:slug', async () => {
    const res = await request('GET', '/api/communities/suggest/estudo', { token: tokenFor(1) });
    assert.equal(res.status, 200);
    assert.equal(res.body.category, 'estudo');
    assert.deepEqual(res.body.suggestions, []);
  });

  test('/smart-suggest/:missionId responde pela própria rota', async () => {
    const res = await request('GET', '/api/communities/smart-suggest/5', { token: tokenFor(1) });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Missão não encontrada.' });
    assert.ok(db.queries.some((q) => /FROM missions WHERE id = \$1/i.test(q.text)));
  });

  test('rotas fixas vêm antes de /:slug', () => {
    const paths = communitiesRouter.stack
      .filter((layer) => layer.route && layer.route.methods.get)
      .map((layer) => layer.route.path);
    assert.ok(paths.indexOf('/suggest/:category') < paths.indexOf('/:slug'));
    assert.ok(paths.indexOf('/smart-suggest/:missionId') < paths.indexOf('/:slug'));
  });

  test('missões de comunidade: só uma rota de ranking e uma de scope', () => {
    const gets = communityMissionsRouter.stack
      .filter((layer) => layer.route && layer.route.methods.get)
      .map((layer) => layer.route.path);
    assert.equal(gets.filter((p) => p === '/:slug/:missionId/ranking').length, 1);
    assert.equal(gets.filter((p) => p === '/:slug/scope/:scope').length, 1);
  });

  test('entrar pela primeira vez soma 1 membro', async () => {
    const res = await request('POST', '/api/communities/foco/join', { token: tokenFor(1) });
    assert.equal(res.status, 200);
    assert.equal(res.body.already_member, false);
    assert.equal(db.communities[0].member_count, 2);
  });

  test('entrar: resposta com o título novo (não a patente antiga); rank fica só por compatibilidade', async () => {
    db.completedMissions.set(1, 6);
    const res = await request('POST', '/api/communities/foco/join', { token: tokenFor(1) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.title, { name: 'Constante', level: 3, marks: 5 });
    assert.equal(res.body.rank, 'Constante');
    assert.equal(res.body.missions_done, 6);
    assert.equal(res.body.message, 'Você entrou na comunidade Foco.');
    assert.doesNotMatch(JSON.stringify(res.body), /patente|recruta|veterano|elite|campe|lenda/i);
    assert.equal(db.lastMemberInsert[2], 'Constante');
    // A contagem é a do mérito (todas as missões de 30 dias), não por categoria.
    assert.ok(db.queries.some((q) => /^SELECT \(SELECT COUNT\(\*\)::int FROM missions mm/.test(q.text)));
    assert.equal(db.queries.some((q) => /AND category = \$2/.test(q.text)), false);
  });

  test('entrar sem missão que conta: sem título', async () => {
    const res = await request('POST', '/api/communities/foco/join', { token: tokenFor(2) });
    assert.equal(res.body.title, null);
    assert.equal(res.body.rank, null);
    assert.equal(db.lastMemberInsert[2], '');
  });

  test('posts: is_mine diz se o post é de quem pede; o user_id nunca sai na resposta', async () => {
    db.posts.push({ id: 1, community_id: 3, user_id: 9, content: 'de outra pessoa' }, { id: 2, community_id: 3, user_id: 2, content: 'meu' });
    const page = await request('GET', '/api/communities/foco', { token: tokenFor(2) });
    assert.deepEqual(page.body.posts.map((p) => [p.id, p.is_mine]), [[1, false], [2, true]]);
    // Caso negado: o post da outra pessoa tem user_id 9 no banco, mas a
    // resposta não pode trazer esse número interno.
    assert.equal(JSON.stringify(page.body).includes('user_id'), false);
    for (const post of page.body.posts) assert.equal('user_id' in post, false);
    makeMember(2);
    const sent = await request('POST', '/api/communities/foco/posts', { token: tokenFor(2), body: { content: 'nova dica' } });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.post.is_mine, true);
    assert.equal('user_id' in sent.body.post, false);
  });

  test('entrar de novo não soma membro', async () => {
    await request('POST', '/api/communities/foco/join', { token: tokenFor(1) });
    const again = await request('POST', '/api/communities/foco/join', { token: tokenFor(1) });
    assert.equal(again.status, 200);
    assert.equal(again.body.already_member, true);
    assert.equal(db.communities[0].member_count, 2);
    const updates = db.queries.filter((q) => /^UPDATE communities SET member_count/i.test(q.text));
    assert.equal(updates.length, 1);
  });

  test('entrar sem login é negado e não soma', async () => {
    const res = await request('POST', '/api/communities/foco/join');
    assert.equal(res.status, 401);
    assert.equal(db.communities[0].member_count, 1);
  });

  // ---------- T2: posts ----------

  test('membro com missão ativa da mesma área publica', async () => {
    makeMember(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: '  Estudei 25 minutos antes do café.  ' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.post.content, 'Estudei 25 minutos antes do café.');
    assert.equal(res.body.crisis, undefined);
  });

  test('sem login: 401 e nada gravado', async () => {
    const res = await request('POST', '/api/communities/foco/posts', {
      body: { content: 'oi' }
    });
    assert.equal(res.status, 401);
    assert.equal(insertedPost(), false);
  });

  test('não membro: 403 e nada gravado', async () => {
    db.completedMissions.set(8, 2);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(8), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Só membros/);
    assert.equal(insertedPost(), false);
  });

  // ---------- Áreas (migração 013): postar pede missão ATIVA da mesma área ----------

  test('negado: membro sem missão ativa: 403 com o motivo, nada gravado', async () => {
    makeMember(2, { areas: [] });
    db.completedMissions.set(2, 5); // missões concluídas não contam mais
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.locked, true);
    assert.equal(res.body.code, 'no_active_mission');
    assert.equal(res.body.error, 'Para postar aqui você precisa de uma missão ativa em Mente.');
    assert.equal(res.body.community_area, 'mente');
    assert.equal(insertedPost(), false);
  });

  test('negado: missão ativa de outra área: 403 dizendo as duas áreas', async () => {
    makeMember(2, { areas: ['corpo'] });
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'other_area');
    assert.equal(res.body.error, 'Sua missão ativa é de Corpo. Esta comunidade é de Mente.');
    assert.equal(insertedPost(), false);
  });

  test('negado: missão ativa antiga, sem área: 403 com o motivo', async () => {
    makeMember(2, { areas: [null] });
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'mission_without_area');
    assert.match(res.body.error, /ainda não tem área/);
    assert.equal(insertedPost(), false);
  });

  test('uma missão de outra área não atrapalha: basta uma ativa da mesma área', async () => {
    makeMember(2, { areas: ['corpo', null, 'mente'] });
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 201);
  });

  test('só missão ATIVA entra na conta (o SQL pede status active, dono ou parceiro)', async () => {
    makeMember(2);
    await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    const q = db.queries.find((item) => /^SELECT m\.area FROM missions m/i.test(item.text));
    assert.ok(q);
    // Dono ou parceiro do Duo de verdade; a missão do rival não conta.
    assert.ok(q.text.includes(RULE_TEXT('$1', 'm')), 'regra de quem participa');
    assert.match(q.text, /m\.status = 'active'$/);
    assert.deepEqual(q.params, [2]);
  });

  test('só leitura: ligado só na Alimentação (decisão de 27/11)', () => {
    const { READ_ONLY_COMMUNITY_SLUGS, isReadOnlyCommunity } = require('../lib/community-access');
    assert.deepEqual(READ_ONLY_COMMUNITY_SLUGS, ['alimentacao']);
    assert.equal(isReadOnlyCommunity('alimentacao'), true);
    assert.equal(isReadOnlyCommunity('corrida'), false);
  });

  test('negado: postar na Alimentação, mesmo com missão ativa de Corpo: 403 read_only, nada gravado', async () => {
    makeMember(2, { areas: ['corpo'], communityId: 8 });
    const res = await request('POST', '/api/communities/alimentacao/posts', {
      token: tokenFor(2), body: { content: 'uma dica de almoço' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'read_only');
    assert.equal(res.body.error, 'Os posts aqui abrem em breve. Por enquanto, dá para ler.');
    assert.equal(insertedPost(), false);
  });

  test('ler a Alimentação funciona (com e sem missão), sem poder postar', async () => {
    db.posts.push({ id: 1, community_id: 8, user_id: 9, content: 'dica antiga' });
    makeMember(2, { areas: ['corpo'], communityId: 8 });
    for (const user of [2, 5]) {
      const res = await request('GET', '/api/communities/alimentacao', { token: tokenFor(user) });
      assert.equal(res.status, 200);
      assert.equal(res.body.access.can_read_forum, true);
      assert.equal(res.body.access.can_post_forum, false);
      assert.equal(res.body.posts.length, 1);
    }
  });

  test('outra comunidade de Corpo continua aberta para posts', async () => {
    makeMember(2, { areas: ['corpo'], communityId: 7 });
    const res = await request('POST', '/api/communities/corrida/posts', {
      token: tokenFor(2), body: { content: 'corri 3 km' }
    });
    assert.equal(res.status, 201);
  });

  test('negado: com a comunidade na lista de só leitura, ninguém posta, mas lê', async () => {
    const { READ_ONLY_COMMUNITY_SLUGS } = require('../lib/community-access');
    READ_ONLY_COMMUNITY_SLUGS.push('foco');
    try {
      makeMember(2);
      const res = await request('POST', '/api/communities/foco/posts', {
        token: tokenFor(2), body: { content: 'uma dica' }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'read_only');
      assert.equal(res.body.error, 'Os posts aqui abrem em breve. Por enquanto, dá para ler.');
      assert.equal(insertedPost(), false);
      const read = await request('GET', '/api/communities/foco', { token: tokenFor(2) });
      assert.equal(read.status, 200);
      assert.equal(read.body.access.can_read_forum, true);
      assert.equal(read.body.access.can_post_forum, false);
      assert.equal(read.body.access.post_code, 'read_only');
    } finally {
      READ_ONLY_COMMUNITY_SLUGS.splice(READ_ONLY_COMMUNITY_SLUGS.indexOf('foco'), 1);
    }
  });

  test('crise vale mesmo na comunidade de só leitura (ajuda, nada gravado)', async () => {
    const { READ_ONLY_COMMUNITY_SLUGS } = require('../lib/community-access');
    READ_ONLY_COMMUNITY_SLUGS.push('foco');
    try {
      makeMember(2);
      const res = await request('POST', '/api/communities/foco/posts', {
        token: tokenFor(2), body: { content: 'quero me matar' }
      });
      assert.equal(res.body.crisis, true);
      assert.equal(insertedPost(), false);
    } finally {
      READ_ONLY_COMMUNITY_SLUGS.splice(READ_ONLY_COMMUNITY_SLUGS.indexOf('foco'), 1);
    }
  });

  test('negado: comunidade ainda sem área: ninguém posta', async () => {
    makeMember(2, { communityId: 4 });
    const res = await request('POST', '/api/communities/sem-area/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'community_without_area');
    assert.equal(insertedPost(), false);
  });

  test('negado: antes da 013, postar dá 503 calmo, sem 500 e nada gravado', async () => {
    makeMember(2);
    db.before013 = true;
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'unavailable');
    assert.equal(res.body.error, 'Os posts ainda não estão disponíveis. Tente de novo mais tarde.');
    assert.equal(insertedPost(), false);
  });

  test('negado: coluna da comunidade existe, mas a das missões não: 503, não 500', async () => {
    makeMember(2);
    db.missionAreaMissing = true;
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 503);
    assert.equal(insertedPost(), false);
  });

  // ---------- Ler é aberto ----------

  test('ler sem missão e sem ser membro: 200 com os posts, sem poder postar', async () => {
    db.posts.push({ id: 1, community_id: 3, user_id: 9, content: 'dica antiga' });
    const res = await request('GET', '/api/communities/foco', { token: tokenFor(2) });
    assert.equal(res.status, 200);
    assert.equal(res.body.access.can_read_forum, true);
    assert.equal(res.body.access.can_post_forum, false);
    assert.equal(res.body.access.post_code, 'no_active_mission');
    assert.equal(res.body.posts.length, 1);
    assert.equal(res.body.posts[0].content, 'dica antiga');
  });

  test('ler com missão ativa da área, sem ser membro: pode ler; postar pede entrar', async () => {
    db.activeAreas.set(2, ['mente']);
    const res = await request('GET', '/api/communities/foco', { token: tokenFor(2) });
    assert.equal(res.status, 200);
    assert.equal(res.body.access.can_post_forum, false);
    assert.equal(res.body.access.post_code, 'not_member');
  });

  test('membro com missão ativa da área: a página diz que pode postar', async () => {
    makeMember(2);
    const res = await request('GET', '/api/communities/foco', { token: tokenFor(2) });
    assert.equal(res.body.access.can_post_forum, true);
    assert.equal(res.body.access.post_code, 'ok');
    assert.equal(res.body.access.post_requirement, '');
  });

  test('antes da 013, ler continua funcionando (sem 500) e ninguém posta', async () => {
    makeMember(2);
    db.before013 = true;
    db.posts.push({ id: 1, community_id: 3, user_id: 9, content: 'dica antiga' });
    const res = await request('GET', '/api/communities/foco', { token: tokenFor(2) });
    assert.equal(res.status, 200);
    assert.equal(res.body.posts.length, 1);
    assert.equal(res.body.access.can_post_forum, false);
    assert.equal(res.body.access.post_code, 'unavailable');
  });

  test('negado: ler sem login: 401', async () => {
    const res = await request('GET', '/api/communities/foco');
    assert.equal(res.status, 401);
  });

  // ---------- Recomendadas para uma missão ----------

  test('recomendadas: só a mesma área, o assunto parecido primeiro (sem acento, por palavra)', async () => {
    db.missions.push({ id: 40, user_id: 2, partner_id: null, area: 'mente', subject: 'Psicológia e leitura' });
    const res = await request('GET', '/api/communities/recommended/40', { token: tokenFor(2) });
    assert.equal(res.status, 200);
    assert.equal(res.body.area, 'mente');
    assert.equal(res.body.area_label, 'Mente');
    const slugs = res.body.communities.map((c) => c.slug);
    assert.deepEqual(slugs, ['psicologia', 'idiomas', 'foco']);
    assert.equal(res.body.communities[0].subject_match, true);
    assert.equal(res.body.communities[1].subject_match, false);
    assert.equal(slugs.includes('corrida'), false);
  });

  test('recomendadas: o parceiro do Duo também vê as da missão', async () => {
    db.missions.push({ id: 41, user_id: 2, partner_id: 3, area: 'corpo', subject: null });
    const res = await request('GET', '/api/communities/recommended/41', { token: tokenFor(3) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.communities.map((c) => c.slug), ['corrida', 'alimentacao']);
  });

  test('negado: recomendadas da missão de outra pessoa: 404, sem dizer se existe', async () => {
    db.missions.push({ id: 42, user_id: 2, partner_id: null, area: 'mente', subject: 'idiomas' });
    const other = await request('GET', '/api/communities/recommended/42', { token: tokenFor(8) });
    const missing = await request('GET', '/api/communities/recommended/999', { token: tokenFor(8) });
    const bad = await request('GET', '/api/communities/recommended/abc', { token: tokenFor(8) });
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, missing.body);
    assert.equal(bad.status, 404);
    assert.equal(db.queries.some((q) => /WHERE c\.area = \$2/.test(q.text)), false);
    const ask = db.queries.find((q) => /^SELECT id, area, subject FROM missions/.test(q.text));
    assert.match(ask.text, /WHERE id = \$1 AND \(user_id = \$2 OR partner_id = \$2\)$/);
    assert.deepEqual(ask.params, [42, 8]);
  });

  test('recomendadas: missão sem área responde vazio, com o motivo', async () => {
    db.missions.push({ id: 43, user_id: 2, partner_id: null, area: null, subject: null });
    const res = await request('GET', '/api/communities/recommended/43', { token: tokenFor(2) });
    assert.equal(res.status, 200);
    assert.equal(res.body.area, null);
    assert.deepEqual(res.body.communities, []);
    assert.match(res.body.message, /não tem área/);
  });

  test('negado: recomendadas antes da 013: 503 calmo', async () => {
    db.before013 = true;
    const res = await request('GET', '/api/communities/recommended/40', { token: tokenFor(2) });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'unavailable');
  });

  test('negado: recomendadas sem login: 401; sem 18+: 403', async () => {
    const semLogin = await request('GET', '/api/communities/recommended/40');
    assert.equal(semLogin.status, 401);
    db.notAdult.add(2);
    const semIdade = await request('GET', '/api/communities/recommended/40', { token: tokenFor(2) });
    assert.equal(semIdade.status, 403);
    assert.equal(semIdade.body.code, 'adult_confirmation_required');
  });

  test('/recommended/:missionId vem antes de /:slug', () => {
    const paths = communitiesRouter.stack
      .filter((layer) => layer.route && layer.route.methods.get)
      .map((layer) => layer.route.path);
    assert.ok(paths.indexOf('/recommended/:missionId') >= 0);
    assert.ok(paths.indexOf('/recommended/:missionId') < paths.indexOf('/:slug'));
  });

  test('comunidade inexistente: 404', async () => {
    makeMember(1);
    const res = await request('POST', '/api/communities/nao-existe/posts', {
      token: tokenFor(1), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 404);
    assert.equal(insertedPost(), false);
  });

  test('crise alto: não grava, texto não chega ao banco nem ao log', async () => {
    makeMember(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'hoje eu quero me matar' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(res.body.posted, false);
    assert.equal(res.body.post, undefined);
    assert.equal(insertedPost(), false);
    assert.equal(textReachedDb('matar'), false);
    assert.equal(consoleCalls.length, 0);
  });

  test('crise médio: não grava e devolve crisis_level medio', async () => {
    makeMember(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'sinto que sou um peso' }
    });
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'medio');
    assert.equal(insertedPost(), false);
    assert.equal(textReachedDb('peso'), false);
  });

  test('crise vale também para quem não é membro (mostra a ajuda, não grava)', async () => {
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(9), body: { content: 'quero me matar' }
    });
    assert.equal(res.body.crisis, true);
    assert.equal(insertedPost(), false);
  });

  test('crise num post longo demais ainda mostra a ajuda', async () => {
    makeMember(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: `quero me matar ${'a'.repeat(400)}` }
    });
    assert.equal(res.body.crisis, true);
    assert.equal(insertedPost(), false);
  });

  test('281 caracteres: 400 e nada gravado', async () => {
    makeMember(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'a'.repeat(281) }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /280 caracteres/);
    assert.equal(insertedPost(), false);
  });

  test('280 caracteres com emoji contam como 280: publica', async () => {
    makeMember(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: '🔥'.repeat(280) }
    });
    assert.equal(res.status, 201);
  });

  test('vazio ou não texto: 400', async () => {
    makeMember(1);
    const empty = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: '   ' }
    });
    const notText = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: { a: 1 } }
    });
    assert.equal(empty.status, 400);
    assert.equal(notText.status, 400);
    assert.equal(insertedPost(), false);
  });

  test('limite: com 3 posts em 24 horas, o 4.º é recusado com 429', async () => {
    makeMember(1, { recent: 3 });
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'mais uma dica' }
    });
    assert.equal(res.status, 429);
    assert.equal(res.body.limit, 3);
    assert.match(res.body.error, /24 horas/);
    assert.equal(insertedPost(), false);
    assert.ok(db.queries.some((q) => q.text === 'ROLLBACK'));
  });

  test('limite: com 2 posts, o 3.º passa e o seguinte não', async () => {
    makeMember(1, { recent: 2 });
    const third = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'terceira dica' }
    });
    const fourth = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'quarta dica' }
    });
    assert.equal(third.status, 201);
    assert.equal(fourth.status, 429);
    assert.equal(db.posts.length, 1);
  });

  test('o limite trava a linha da pessoa antes de contar', async () => {
    makeMember(1);
    await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'dica' }
    });
    const texts = db.queries.map((q) => q.text);
    const lock = texts.findIndex((t) => /FOR UPDATE/.test(t));
    const count = texts.findIndex((t) => /24 hours/.test(t));
    assert.ok(lock >= 0 && lock < count);
  });

  test('erro do banco: 500 calmo, sem log e com ROLLBACK', async () => {
    makeMember(1);
    db.failInsert = true;
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'texto qualquer do post' }
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Tente de novo/);
    assert.equal(consoleCalls.length, 0);
    assert.ok(db.queries.some((q) => q.text === 'ROLLBACK'));
  });

  // ---------- 18+ confirmado ----------

  test('negado: entrar sem 18+ confirmado (403 com código), sem virar membro', async () => {
    db.notAdult.add(1);
    const res = await request('POST', '/api/communities/foco/join', { token: tokenFor(1) });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'adult_confirmation_required');
    assert.match(res.body.error, /maiores de 18 anos/);
    assert.equal(db.members.length, 0);
    assert.equal(db.communities[0].member_count, 1);
  });

  test('negado: publicar sem 18+ confirmado (403 com código), nada gravado', async () => {
    makeMember(1);
    db.notAdult.add(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'adult_confirmation_required');
    assert.equal(res.body.adult_confirmation_required, true);
    assert.equal(insertedPost(), false);
  });

  test('sem 18+ e post com crise: a ajuda aparece antes, nada gravado', async () => {
    makeMember(1);
    db.notAdult.add(1);
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(1), body: { content: 'quero me matar' }
    });
    assert.equal(res.body.crisis, true);
    assert.equal(insertedPost(), false);
  });

  test('com 18+ confirmado: entra normalmente', async () => {
    const res = await request('POST', '/api/communities/foco/join', { token: tokenFor(1) });
    assert.equal(res.status, 200);
    assert.ok(db.queries.some((q) => /adult_confirmed FROM users WHERE id = \$1$/.test(q.text)));
  });

  test('negado: sem 18+, toda rota da comunidade dá 403 com código (leitura e escrita)', async () => {
    makeMember(1);
    db.notAdult.add(1);
    const t = tokenFor(1);
    const calls = [
      ['GET', '/api/communities'],
      ['GET', '/api/communities/suggest/estudo'],
      ['GET', '/api/communities/smart-suggest/5'],
      ['GET', '/api/communities/recommended/5'],
      ['GET', '/api/communities/foco'],
      ['POST', '/api/communities', { name: 'Nova', category: 'estudo' }],
      ['POST', '/api/communities/foco/join'],
      ['POST', '/api/communities/foco/posts', { content: 'uma dica' }],
      ['POST', '/api/communities/foco/posts/1/report', { reason: 'spam' }]
    ];
    for (const [method, path, body] of calls) {
      const res = await request(method, path, { token: t, body });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.code, 'adult_confirmation_required', `${method} ${path}`);
    }
    // Só a pergunta da idade chegou ao banco.
    assert.ok(db.queries.every((q) => /adult_confirmed FROM users/.test(q.text)));
  });

  test('sem 18+ e texto de crise em qualquer rota: ajuda, nada segue nem é gravado', async () => {
    db.notAdult.add(1);
    const res = await request('POST', '/api/communities', {
      token: tokenFor(1), body: { name: 'Nova', category: 'estudo', content: 'quero me matar' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.saved, false);
    assert.ok(db.queries.every((q) => /adult_confirmed FROM users/.test(q.text)));
  });

  test('rotas de admin ficam fora do portão 18+ (só o critério de admin vale)', async () => {
    db.notAdult.add(1);
    const res = await request('POST', '/api/communities/admin/posts/1/restore', { token: tokenFor(1) });
    assert.notEqual(res.status, 403);
    assert.equal(db.queries.some((q) => /adult_confirmed FROM users/.test(q.text)), false);
  });

  test('negado: sem login, o portão responde 401 antes de perguntar a idade', async () => {
    const res = await request('GET', '/api/communities/foco');
    assert.equal(res.status, 401);
    assert.equal(db.queries.length, 0);
  });
});
