// Mérito e ranking (PR D da comunidade). Banco simulado; a ordem e as
// regras do SQL foram conferidas num Postgres descartável.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const merit = require('../lib/merit');
const communitiesRouter = require('../routes/communities');

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

describe('títulos (opção A)', () => {
  test('limites: 1, 3, 6, 12 e 24', () => {
    const at = (n) => merit.titleFor(n)?.name || null;
    assert.deepEqual([0, 1, 2, 3, 5, 6, 11, 12, 23, 24, 99].map(at),
      [null, 'Iniciante', 'Iniciante', 'Praticante', 'Praticante', 'Constante', 'Constante', 'Veterano', 'Veterano', 'Referência', 'Referência']);
    assert.deepEqual(merit.titleFor(6), { name: 'Constante', level: 3, marks: 5 });
  });

  test('próximo título e quanto falta; no topo, nada', () => {
    assert.deepEqual(merit.nextTitle(0), { name: 'Iniciante', missions: 1, missing: 1 });
    assert.deepEqual(merit.nextTitle(3), { name: 'Constante', missions: 6, missing: 3 });
    assert.equal(merit.nextTitle(24), null);
  });

  test('negado: valores estranhos contam como zero', () => {
    for (const v of [-1, 1.5, null, undefined, NaN, 'x', {}]) assert.equal(merit.titleFor(v), null, String(v));
  });

  test('o que conta: só missões pessoais, concluídas, de 30 dias ou mais (dono ou parceiro)', () => {
    const sql = normalize(merit.meritCountSql('cm.user_id'));
    assert.match(sql, /^\(SELECT COUNT\(\*\)::int FROM missions mm /);
    assert.match(sql, /\(mm\.user_id = cm\.user_id OR mm\.partner_id = cm\.user_id\)/);
    assert.match(sql, /mm\.status = 'completed'/);
    assert.match(sql, /mm\.duration_days >= 30\)$/);
    // A Maratona vive em community_missions: fora da conta.
    assert.doesNotMatch(sql, /community_missions/);
    assert.throws(() => merit.meritCountSql('x; DROP TABLE users'));
  });
});

// ---------- Rotas ----------

const db = {};
function resetDb() {
  db.queries = [];
  db.notAdult = new Set();
  db.missions = new Map([[5, 4]]);
  db.rankingRows = [];
  db.communities = [{ id: 3, slug: 'foco' }];
  db.postRows = [];
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (/adult_confirmed_at'\) IS NOT NULL AS adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !db.notAdult.has(Number(params[0])) }] };
  }
  if (/^SELECT \(SELECT COUNT\(\*\)::int FROM missions mm/.test(text) && /FROM users u WHERE u\.id = \$1$/.test(text)) {
    return { rows: [{ missions: db.missions.get(Number(params[0])) || 0 }] };
  }
  if (/^SELECT id FROM communities WHERE slug = \$1$/.test(text)) {
    return { rows: db.communities.filter((c) => c.slug === params[0]) };
  }
  if (/^WITH members AS/.test(text)) return { rows: db.rankingRows };
  if (/^SELECT c\.\*, CASE WHEN cm\.user_id IS NOT NULL/.test(text) && /WHERE c\.slug = \$2$/.test(text)) {
    return { rows: db.communities.filter((c) => c.slug === params[1]).map((c) => ({ ...c, is_member: false, missions_done: 0, total_days: 0 })) };
  }
  if (/FROM community_posts cp JOIN users u ON cp\.user_id = u\.id WHERE cp\.community_id = \$1/.test(text)) {
    return { rows: db.postRows || [] };
  }
  return { rows: [] };
}

const app = express();
app.use(express.json());
app.use('/api/communities', communitiesRouter);
const tokenFor = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
let server;
let baseUrl;

async function call(p, { token = tokenFor(5) } = {}) {
  const r = await fetch(`${baseUrl}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const raw = await r.text();
  return { status: r.status, body: raw ? JSON.parse(raw) : {} };
}

describe('rotas de mérito e ranking', { concurrency: 1 }, () => {
  before(async () => {
    resetDb();
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => resetDb());

  test('meu mérito: missões, título, próximo e a regra', async () => {
    const res = await call('/api/communities/merit/me');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      missions: 4,
      title: { name: 'Praticante', level: 2, marks: 5 },
      next: { name: 'Constante', missions: 6, missing: 2 },
      rule: 'Vale o número de missões. No empate, o tempo na comunidade.'
    });
    const q = db.queries.find((item) => /FROM users u WHERE u\.id = \$1$/.test(item.text));
    assert.deepEqual(q.params, [5]);
  });

  test('meu mérito sem missão: sem título, falta 1', async () => {
    db.missions = new Map();
    const res = await call('/api/communities/merit/me');
    assert.equal(res.body.title, null);
    assert.deepEqual(res.body.next, { name: 'Iniciante', missions: 1, missing: 1 });
  });

  test('ranking: os 3 primeiros + a minha posição, só apelido, título, missões e dias', async () => {
    db.rankingRows = [
      { position: 1, username: 'ana', missions: 7, days_in_community: 40, is_me: false },
      { position: 2, username: 'beto', missions: 3, days_in_community: 9, is_me: false },
      { position: 3, username: 'caio', missions: 3, days_in_community: 2, is_me: false },
      { position: 4, username: 'eu', missions: 1, days_in_community: 0, is_me: true }
    ];
    const res = await call('/api/communities/foco/ranking');
    assert.equal(res.status, 200);
    assert.equal(res.body.top.length, 3);
    assert.deepEqual(res.body.me, { position: 4, username: 'eu', title: { name: 'Iniciante', level: 1, marks: 5 }, missions: 1, days_in_community: 0, is_me: true });
    for (const row of [...res.body.top, res.body.me]) {
      assert.deepEqual(Object.keys(row).sort(), ['days_in_community', 'is_me', 'missions', 'position', 'title', 'username']);
    }
    assert.equal(res.body.rule, 'Vale o número de missões. No empate, o tempo na comunidade.');
  });

  test('o SQL do ranking: só membros, só quem tem missão que conta, desempate pela entrada e pelo id', async () => {
    await call('/api/communities/foco/ranking');
    const q = db.queries.find((item) => /^WITH members AS/.test(item.text));
    assert.match(q.text, /FROM community_members cm JOIN users u ON u\.id = cm\.user_id WHERE cm\.community_id = \$1/);
    assert.match(q.text, /WHERE missions > 0/);
    assert.match(q.text, /ROW_NUMBER\(\) OVER \(ORDER BY missions DESC, joined_at ASC, member_id ASC\)/);
    assert.match(q.text, /WHERE position <= \$3 OR user_id = \$2 ORDER BY position$/);
    assert.deepEqual(q.params, [3, 5, 3]);
    // Nunca devolve id, e-mail nem a data exata de entrada.
    const select = q.text.slice(q.text.lastIndexOf('SELECT position'));
    assert.doesNotMatch(select, /email|u\.id|member_id,|joined_at AS|user_id AS/);
  });

  test('quem não está no ranking: me null', async () => {
    db.rankingRows = [{ position: 1, username: 'ana', missions: 7, days_in_community: 40, is_me: false }];
    const res = await call('/api/communities/foco/ranking');
    assert.equal(res.body.me, null);
  });

  test('negado: comunidade que não existe: 404', async () => {
    const res = await call('/api/communities/nada/ranking');
    assert.equal(res.status, 404);
  });

  test('negado: sem login 401; sem 18+ 403 (mérito e ranking)', async () => {
    for (const p of ['/api/communities/merit/me', '/api/communities/foco/ranking']) {
      assert.equal((await call(p, { token: null })).status, 401, p);
    }
    db.notAdult.add(5);
    for (const p of ['/api/communities/merit/me', '/api/communities/foco/ranking']) {
      const res = await call(p);
      assert.equal(res.status, 403, p);
      assert.equal(res.body.code, 'adult_confirmation_required');
    }
  });

  test('a página da comunidade usa o mesmo ranking (3 + eu), não mais os 10 com patente antiga', async () => {
    await call('/api/communities/foco');
    assert.equal(db.queries.some((q) => /ORDER BY cm\.missions_done DESC, cm\.total_days DESC/.test(q.text)), false);
  });

  test('posts da página trazem o título do autor, sem o número cru nem outro dado', async () => {
    db.postRows = [
      { id: 1, community_id: 3, user_id: 8, content: 'oi', created_at: '2026-11-27', username: 'ana', hidden: false, hidden_reason: null, author_missions: 6 },
      { id: 2, community_id: 3, user_id: 9, content: 'oi', created_at: '2026-11-27', username: 'novo', hidden: false, hidden_reason: null, author_missions: 0 }
    ];
    const res = await call('/api/communities/foco');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.posts[0].author_title, { name: 'Constante', level: 3, marks: 5 });
    assert.equal(res.body.posts[1].author_title, null);
    for (const p of res.body.posts) assert.equal(p.author_missions, undefined);
    const q = db.queries.find((item) => /FROM community_posts cp JOIN users u/.test(item.text));
    assert.match(q.text, /\(mm\.user_id = cp\.user_id OR mm\.partner_id = cp\.user_id\) AND mm\.status = 'completed' AND mm\.duration_days >= 30\) AS author_missions/);
  });

  test('/merit/me vem antes de /:slug; "merit" é nome reservado', () => {
    const paths = communitiesRouter.stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path);
    assert.ok(paths.indexOf('/merit/me') < paths.indexOf('/:slug'));
    assert.ok(paths.indexOf('/:slug/ranking') >= 0);
  });
});
