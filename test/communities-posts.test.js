const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');

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
  recentPosts: new Map(),       // userId -> posts nas últimas 24 horas
  posts: [],
  queries: [],
  failInsert: false
};

function resetDb() {
  db.communities = [{ id: 3, slug: 'foco', name: 'Foco', category: 'estudo', member_count: 1 }];
  db.members = [];
  db.completedMissions = new Map();
  db.recentPosts = new Map();
  db.posts = [];
  db.queries = [];
  db.failInsert = false;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };

  if (/^INSERT INTO community_members/i.test(text)) {
    const exists = db.members.some((m) =>
      m.community_id === Number(params[0]) && m.user_id === Number(params[1]));
    if (exists) return { rows: [], rowCount: 0 };
    db.members.push({ community_id: Number(params[0]), user_id: Number(params[1]) });
    return { rows: [{ id: db.members.length }], rowCount: 1 };
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
    return { rows: c ? [{ ...c }] : [] };
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

function makeMember(userId, { completed = 1, recent = 0 } = {}) {
  db.members.push({ community_id: 3, user_id: userId });
  db.completedMissions.set(userId, completed);
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
    mock.method(Pool.prototype, 'query', async (sql, params) => handle(sql, params));
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

  test('membro com missão concluída publica', async () => {
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

  test('membro sem missão concluída na categoria: 403 locked', async () => {
    makeMember(2, { completed: 0 });
    const res = await request('POST', '/api/communities/foco/posts', {
      token: tokenFor(2), body: { content: 'uma dica' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.locked, true);
    assert.equal(insertedPost(), false);
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
});
