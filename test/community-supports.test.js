// Apoios, destaques e lista por cursor (PR C da comunidade, migração 015).
// Banco simulado; o SQL de verdade foi conferido num Postgres descartável.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');
const { ownOrDuoMissionSql } = require('../lib/mission-participation');
const RULE_TEXT = (who, alias) => String(ownOrDuoMissionSql(who, alias)).replace(/\s+/g, ' ').trim();

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const feed = require('../lib/community-feed');
const access = require('../lib/community-access');
const communitiesRouter = require('../routes/communities');

// ---------- Regras puras ----------

describe('lista por cursor e dia cumprido', () => {
  test('cursor: ida e volta, com microssegundos', () => {
    const c = feed.encodeCursor('2026-11-27 08:01:02.123456', 41);
    assert.match(c, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(feed.decodeCursor(c), { createdAt: '2026-11-27 08:01:02.123456', id: 41 });
    assert.deepEqual(feed.decodeCursor(feed.encodeCursor('2026-11-27 08:01:02', 1)), { createdAt: '2026-11-27 08:01:02', id: 1 });
  });

  test('negado: cursor estranho não vira consulta', () => {
    const bad = [
      '', 'abc', '!!', 'a'.repeat(81), 7, null,
      Buffer.from("2026-11-27 08:01:02|1' OR 1=1", 'utf8').toString('base64url'),
      Buffer.from('ontem|1', 'utf8').toString('base64url'),
      Buffer.from('2026-11-27 08:01:02|0', 'utf8').toString('base64url'),
      Buffer.from('2026-11-27 08:01:02|99999999999', 'utf8').toString('base64url')
    ];
    for (const value of bad) assert.equal(feed.decodeCursor(value), null, String(value));
    assert.equal(feed.encodeCursor('ontem', 1), null);
    assert.equal(feed.encodeCursor('2026-11-27 08:01:02', 0), null);
  });

  const DAY = 24 * 60 * 60 * 1000;
  const lisbon = { reminder_time: '08:00', timezone: 'Europe/Lisbon' };

  test('dia cumprido: check-in de hoje (dia difícil também é check-in feito)', () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const mission = { id: 5, started_at: new Date(now.getTime() - 2 * DAY), mission_weekdays: null };
    assert.equal(feed.dayDone([mission], lisbon, new Map([[5, new Set([3])]]), now), true);
    assert.equal(feed.dayDone([mission], lisbon, new Map([[5, new Set([1, 2])]]), now), false);
    assert.equal(feed.dayDone([], lisbon, new Map(), now), false);
  });

  test('dia livre vale como cumprido', () => {
    // 27/11/2026 é sexta (5). Missão só de segunda a quarta.
    const now = new Date('2026-11-27T12:00:00Z');
    const mission = { id: 6, started_at: new Date('2026-11-23T09:00:00Z'), mission_weekdays: [1, 2, 3] };
    assert.equal(feed.dayDone([mission], lisbon, new Map(), now), true);
  });

  test('a virada do dia é a de Lisboa: 23:30 em Lisboa ainda é o mesmo dia', () => {
    // Começou em 25/11 às 10h de Lisboa. Em 27/11 às 23:30 (Lisboa) é o Dia 3.
    const mission = { id: 7, started_at: new Date('2026-11-25T10:00:00Z'), mission_weekdays: null };
    const lateNight = new Date('2026-11-27T23:30:00Z');
    assert.equal(feed.dayDone([mission], lisbon, new Map([[7, new Set([3])]]), lateNight), true);
    const nextDay = new Date('2026-11-28T00:30:00Z');
    assert.equal(feed.dayDone([mission], lisbon, new Map([[7, new Set([3])]]), nextDay), false);
  });
});

// ---------- Migração 015 ----------

describe('migração 015', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '015_community_post_supports.sql'), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');

  test('só acrescenta, 1 apoio por pessoa por post, sem contador', () => {
    assert.doesNotMatch(code.replace(/ON DELETE CASCADE/g, ''), /\b(DROP|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
    assert.match(code, /CREATE TABLE IF NOT EXISTS community_post_supports/);
    assert.match(code, /UNIQUE \(post_id, user_id\)/);
    assert.match(code, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(code, /post_id INTEGER NOT NULL REFERENCES community_posts\(id\) ON DELETE CASCADE/);
    assert.match(code, /idx_community_posts_feed ON community_posts\(community_id, created_at DESC, id DESC\)/);
    assert.match(code, /'015_community_post_supports'/);
  });

  test('sem moeda nem ponto: nenhuma tabela de saldo', () => {
    assert.doesNotMatch(code, /ledger|coin|moeda|points/i);
  });
});

// ---------- Rotas ----------

const db = {};

function resetDb() {
  db.communities = [
    { id: 3, slug: 'foco' },
    { id: 4, slug: 'outra' }
  ];
  db.posts = [
    { id: 10, community_id: 3, user_id: 1, hidden: false },
    { id: 11, community_id: 3, user_id: 2, hidden: true },
    { id: 12, community_id: 4, user_id: 1, hidden: false }
  ];
  db.supports = []; // { post_id, user_id }
  db.queries = [];
  db.notAdult = new Set();
  db.before015 = false;
  db.feedRows = [];
  db.missions = [];
  db.done = [];
  db.highlights = [];
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

const missingTable = () => Object.assign(new Error('relation "community_post_supports" does not exist'), { code: '42P01' });

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (/adult_confirmed_at'\) IS NOT NULL AS adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !db.notAdult.has(Number(params[0])) }] };
  }
  if (/^SELECT id, slug FROM communities WHERE slug = \$1$/.test(text)) {
    return { rows: db.communities.filter((c) => c.slug === params[0]) };
  }
  if (/^SELECT cp\.id, cp\.user_id, \(to_jsonb\(cp\) ->> 'hidden_at'\) IS NOT NULL AS hidden FROM community_posts cp WHERE cp\.id = \$1 AND cp\.community_id = \$2$/.test(text)) {
    return { rows: db.posts.filter((p) => p.id === Number(params[0]) && p.community_id === Number(params[1])) };
  }
  if (/community_post_supports/.test(text) && db.before015) throw missingTable();
  if (/^INSERT INTO community_post_supports \(post_id, user_id\) VALUES \(\$1, \$2\) ON CONFLICT \(post_id, user_id\) DO NOTHING RETURNING id$/.test(text)) {
    const exists = db.supports.some((s) => s.post_id === Number(params[0]) && s.user_id === Number(params[1]));
    if (exists) return { rows: [], rowCount: 0 };
    db.supports.push({ post_id: Number(params[0]), user_id: Number(params[1]) });
    return { rows: [{ id: db.supports.length }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\)::int AS total FROM community_post_supports WHERE post_id = \$1$/.test(text)) {
    return { rows: [{ total: db.supports.filter((s) => s.post_id === Number(params[0])).length }] };
  }
  if (/^DELETE FROM community_post_supports WHERE post_id = \$1 AND user_id = \$2 RETURNING id$/.test(text)) {
    const before = db.supports.length;
    db.supports = db.supports.filter((s) => !(s.post_id === Number(params[0]) && s.user_id === Number(params[1])));
    return { rows: [], rowCount: before - db.supports.length };
  }
  if (/^SELECT to_char\(reminder_time, 'HH24:MI'\) AS reminder_time, timezone FROM users WHERE id = \$1$/.test(text)) {
    return { rows: [{ reminder_time: '08:00', timezone: 'Europe/Lisbon' }] };
  }
  if (text === `SELECT m.* FROM missions m WHERE ${RULE_TEXT('$1', 'm')} AND m.status = 'active'`) {
    return { rows: db.missions };
  }
  if (/^SELECT mission_id, day_number FROM checkins WHERE user_id = \$1 AND completed = true AND mission_id = ANY\(\$2::int\[\]\)$/.test(text)) {
    return { rows: db.done };
  }
  if (/FROM community_posts cp JOIN users u ON cp\.user_id = u\.id WHERE cp\.community_id = \$1 AND \(\(to_jsonb\(cp\)/.test(text)) {
    return { rows: db.feedRows.slice(0, Number(params[4])) };
  }
  if (/JOIN community_post_supports s ON s\.post_id = cp\.id AND s\.created_at > NOW\(\)/.test(text)) {
    return { rows: db.highlights };
  }
  return { rows: [] };
}

const app = express();
app.use(express.json());
app.use('/api/communities', communitiesRouter);

const tokenFor = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
let server;
let baseUrl;

async function call(method, p, { token = tokenFor(5) } = {}) {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const raw = await r.text();
  return { status: r.status, body: raw ? JSON.parse(raw) : {} };
}

const inserts = () => db.queries.filter((q) => /^INSERT INTO community_post_supports/.test(q.text)).length;

describe('apoios, destaques e lista', { concurrency: 1 }, () => {
  before(async () => {
    resetDb();
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({ query: async (sql, params) => handle(sql, params), release() {} }));
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => resetDb());

  test('apoiar: 201 com o total; a resposta não diz quem apoiou', async () => {
    const res = await call('POST', '/api/communities/foco/posts/10/support');
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { supported: true, supports: 1 });
  });

  test('negado: apoiar duas vezes: 409, o total não sobe', async () => {
    await call('POST', '/api/communities/foco/posts/10/support');
    const again = await call('POST', '/api/communities/foco/posts/10/support');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_supported');
    assert.equal(again.body.error, 'Você já apoiou este post.');
    assert.equal(again.body.supports, 1);
    assert.equal(db.supports.length, 1);
  });

  test('negado: apoiar o próprio post: 403, nada gravado', async () => {
    const res = await call('POST', '/api/communities/foco/posts/10/support', { token: tokenFor(1) });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'own_post');
    assert.equal(res.body.error, 'Você não pode apoiar o seu próprio post.');
    assert.equal(inserts(), 0);
  });

  test('negado: post escondido, de outra comunidade, inexistente ou id inválido: 404', async () => {
    for (const p of ['/api/communities/foco/posts/11/support', '/api/communities/foco/posts/12/support',
      '/api/communities/foco/posts/999/support', '/api/communities/foco/posts/abc/support',
      '/api/communities/nada/posts/10/support']) {
      const res = await call('POST', p);
      assert.equal(res.status, 404, p);
    }
    assert.equal(inserts(), 0);
  });

  test('negado: sem login 401; sem 18+ 403 (apoiar, tirar, lista e destaques)', async () => {
    const paths = [
      ['POST', '/api/communities/foco/posts/10/support'],
      ['DELETE', '/api/communities/foco/posts/10/support'],
      ['GET', '/api/communities/foco/posts'],
      ['GET', '/api/communities/foco/highlights']
    ];
    for (const [m, p] of paths) {
      const res = await call(m, p, { token: null });
      assert.equal(res.status, 401, `${m} ${p}`);
    }
    db.notAdult.add(5);
    for (const [m, p] of paths) {
      const res = await call(m, p);
      assert.equal(res.status, 403, `${m} ${p}`);
      assert.equal(res.body.code, 'adult_confirmation_required');
    }
    assert.equal(inserts(), 0);
  });

  test('negado: comunidade só leitura: apoiar dá 403 read_only', async () => {
    access.READ_ONLY_COMMUNITY_SLUGS.push('foco');
    try {
      const res = await call('POST', '/api/communities/foco/posts/10/support');
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'read_only');
      assert.equal(inserts(), 0);
    } finally {
      access.READ_ONLY_COMMUNITY_SLUGS.splice(access.READ_ONLY_COMMUNITY_SLUGS.indexOf('foco'), 1);
    }
  });

  test('tirar o apoio: 200, o total cai; tirar de novo não quebra', async () => {
    await call('POST', '/api/communities/foco/posts/10/support');
    const off = await call('DELETE', '/api/communities/foco/posts/10/support');
    assert.deepEqual(off.body, { supported: false, removed: true, supports: 0 });
    const again = await call('DELETE', '/api/communities/foco/posts/10/support');
    assert.equal(again.status, 200);
    assert.equal(again.body.removed, false);
  });

  test('negado: antes da 015: 503 calmo (apoiar, lista, destaques)', async () => {
    db.before015 = true;
    for (const [m, p] of [['POST', '/api/communities/foco/posts/10/support'], ['GET', '/api/communities/foco/posts'], ['GET', '/api/communities/foco/highlights']]) {
      const res = await call(m, p);
      assert.equal(res.status, 503, `${m} ${p}`);
      assert.equal(res.body.code, 'unavailable');
    }
  });

  test('apoiar só mexe em comunidades, posts e apoios (sem moeda, sem ponto)', async () => {
    await call('POST', '/api/communities/foco/posts/10/support');
    const own = db.queries.filter((q) => !/adult_confirmed|FROM users WHERE id = \$1 LIMIT 1|SELECT 1 FROM users/i.test(q.text));
    for (const q of own) {
      assert.match(q.text, /communities|community_posts|community_post_supports/, q.text);
      assert.doesNotMatch(q.text, /ledger|coin|points|score/i, q.text);
    }
  });

  const row = (id, t) => ({ id, community_id: 3, user_id: 2, content: `post ${id}`, created_at: t, cursor_time: t, username: 'beta', hidden: false, hidden_reason: null, supports: 0, supported_by_me: false });

  test('lista sem o dia cumprido: 10 por vez, «Ver anteriores», com o cursor do último', async () => {
    db.feedRows = Array.from({ length: 11 }, (_, i) => row(30 - i, `2026-11-27 08:00:${String(59 - i).padStart(2, '0')}.000001`));
    const res = await call('GET', '/api/communities/foco/posts');
    assert.equal(res.status, 200);
    assert.equal(res.body.posts.length, 10);
    assert.equal(res.body.page_size, 10);
    assert.equal(res.body.continuous_scroll, false);
    assert.equal(res.body.scroll_hint, 'Registre o dia para a lista rolar sozinha.');
    assert.deepEqual(feed.decodeCursor(res.body.next_cursor), { createdAt: '2026-11-27 08:00:50.000001', id: 21 });
    assert.equal(res.body.posts[0].cursor_time, undefined);
    assert.equal(res.body.posts[0].author_title, null);
    assert.equal(res.body.posts[0].author_missions, undefined);
    // is_mine: quem pede (5) não é o autor (2). user_id fica por compatibilidade (obsoleto).
    assert.equal(res.body.posts[0].is_mine, false);
    db.feedRows = [row(40, '2026-11-27 09:00:00'), { ...row(41, '2026-11-27 08:59:00'), user_id: 5 }];
    const mine = await call('GET', '/api/communities/foco/posts');
    assert.deepEqual(mine.body.posts.map((p) => p.is_mine), [false, true]);
    const q = db.queries.find((item) => /ORDER BY cp\.created_at DESC, cp\.id DESC LIMIT \$5$/.test(item.text));
    assert.deepEqual(q.params, [3, 5, null, null, 11]);
    assert.doesNotMatch(q.text, /OFFSET/);
  });

  test('lista: a página seguinte usa o cursor (created_at, id), nunca OFFSET', async () => {
    const cursor = feed.encodeCursor('2026-11-27 08:00:50.000001', 21);
    const res = await call('GET', `/api/communities/foco/posts?cursor=${cursor}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.next_cursor, null);
    const q = db.queries.find((item) => /LIMIT \$5$/.test(item.text));
    assert.match(q.text, /\(cp\.created_at, cp\.id\) < \(\$3::timestamp, \$4::int\)/);
    assert.deepEqual(q.params.slice(2), ['2026-11-27 08:00:50.000001', 21, 11]);
  });

  test('negado: cursor inválido: 400, sem consultar posts', async () => {
    const res = await call('GET', '/api/communities/foco/posts?cursor=lixo!');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_cursor');
    assert.equal(db.queries.some((q) => /LIMIT \$5$/.test(q.text)), false);
  });

  test('com o dia cumprido hoje: rolagem contínua, 20 por vez', async () => {
    const started = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    db.missions = [{ id: 9, started_at: started, mission_weekdays: null, status: 'active' }];
    const { missionDayContextFor } = require('../lib/mission-days');
    const today = missionDayContextFor(db.missions[0], '08:00', 'Europe/Lisbon').dayNumber;
    db.done = [{ mission_id: 9, day_number: today }];
    const res = await call('GET', '/api/communities/foco/posts');
    assert.equal(res.body.continuous_scroll, true);
    assert.equal(res.body.page_size, 20);
    assert.equal(res.body.scroll_hint, null);
    db.done = [{ mission_id: 9, day_number: today - 1 }];
    const notToday = await call('GET', '/api/communities/foco/posts');
    assert.equal(notToday.body.continuous_scroll, false);
  });

  test('destaques: até 3, só apoios dos últimos 7 dias, post escondido fica de fora', async () => {
    db.highlights = [{ id: 10, week_supports: 4, supports: 6, supported_by_me: false, author_missions: 3 }];
    const res = await call('GET', '/api/communities/foco/highlights');
    assert.equal(res.status, 200);
    // Título do autor (PR D): nome e nível, sem o número cru.
    assert.deepEqual(res.body, {
      highlights: [{ id: 10, week_supports: 4, supports: 6, supported_by_me: false, author_title: { name: 'Praticante', level: 2, marks: 5 }, is_mine: false }],
      days: 7,
      max: 3
    });
    const q = db.queries.find((item) => /JOIN community_post_supports s ON/.test(item.text));
    assert.match(q.text, /AND \(to_jsonb\(cp\) ->> 'hidden_at'\) IS NULL GROUP BY/);
    assert.match(q.text, /s\.created_at > NOW\(\) - \(\$3::int \* INTERVAL '1 day'\)/);
    assert.match(q.text, /ORDER BY week_supports DESC, cp\.created_at DESC, cp\.id DESC LIMIT \$4$/);
    assert.deepEqual(q.params, [3, 5, 7, 3]);
    assert.doesNotMatch(q.text, /s\.user_id AS|json_agg|array_agg/);
  });
});
