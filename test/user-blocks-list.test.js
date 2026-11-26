// Lista de bloqueios: GET /api/users/me/blocks e
// DELETE /api/users/me/blocks/:blockId.
// Os 11 casos do desenho de 26/11/2026. Banco simulado: nenhuma conexão real.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const usersRouter = require('../routes/users');
const messagesRouter = require('../routes/messages');
const { tryMatchMission } = require('../routes/missions');
const { resetAllAttempts } = require('../lib/password-attempts');
const {
  BLOCK_LIST_GET_LIMIT,
  BLOCK_LIST_GET_WINDOW_MS,
  BLOCK_LIST_DELETE_LIMIT,
  BLOCK_LIST_DELETE_WINDOW_MS,
  resetBlockListLimits
} = require('../lib/block-list-limit');

const PASSWORD = 'senha-de-teste';
const HASH = bcrypt.hashSync(PASSWORD, 4);

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
app.use('/api/messages', messagesRouter);

const db = {};
const consoleCalls = [];

function resetDb() {
  db.migrated = true;
  db.queries = [];
  db.users = [10, 11, 12, 13].map((id) => ({
    id,
    username: `pessoa-${id}`,
    password: HASH
  }));
  db.users[0].username = 'pessoa-dez';
  db.users[1].username = 'pessoa-onze';
  db.users[2].username = 'pessoa-doze';
  db.users[3].username = 'pessoa-treze';
  db.blocks = [];
  db.missions = [];
  db.matches = [];
  db.messages = [];
  resetBlockListLimits();
  resetAllAttempts();
  consoleCalls.length = 0;
}

const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const missingRelation = () => Object.assign(new Error('relation does not exist'), { code: '42P01' });
const missionById = (id) => db.missions.find((m) => m.id === Number(id));
const activeMatchOf = (id) => db.matches.find((mm) => mm.status === 'active' && (mm.mission_a_id === id || mm.mission_b_id === id));
const blockedPair = (a, b) => db.blocks.some((row) => (
  (row.blocker_id === Number(a) && row.blocked_id === Number(b))
  || (row.blocker_id === Number(b) && row.blocked_id === Number(a))
));

function duoMissions() {
  db.missions = [
    { id: 100, user_id: 10, partner_id: null, mode: 'solo', status: 'active', match_preference: 'parceiro', level: 'iniciante', category: 'estudo' },
    { id: 101, user_id: 11, partner_id: null, mode: 'solo', status: 'active', match_preference: 'parceiro', level: 'iniciante', category: 'estudo' }
  ];
  db.matches = [];
  db.messages = [];
}

function soloAgain() {
  for (const mm of db.matches) mm.status = 'ended';
  for (const mission of db.missions) {
    Object.assign(mission, {
      mode: 'solo',
      partner_id: null,
      match_preference: 'parceiro',
      status: 'active'
    });
  }
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (!db.migrated && /user_blocks|message_reports/.test(text) && !/to_regclass/.test(text)) {
    throw missingRelation();
  }
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text === 'SAVEPOINT passo_opcional' || text === 'RELEASE SAVEPOINT passo_opcional' || text === 'ROLLBACK TO SAVEPOINT passo_opcional') {
    return { rows: [], rowCount: 0 };
  }
  if (/^SELECT id, password FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) {
    const user = db.users.find((item) => item.id === Number(params[0]));
    return { rows: user ? [{ id: user.id, password: user.password }] : [] };
  }
  if (/^DELETE FROM users WHERE id = \$1$/.test(text)) {
    const id = Number(params[0]);
    const had = db.users.some((item) => item.id === id);
    db.users = db.users.filter((item) => item.id !== id);
    return { rows: [], rowCount: had ? 1 : 0 };
  }
  if (/^DELETE FROM user_blocks\b/.test(text)) {
    // A frase da exclusão de conta contém "blocked_id = $1", que não é o id da linha.
    if (/blocker_id = \$1 OR blocked_id = \$1/.test(text)) {
      const userId = Number(params[0]);
      const before = db.blocks.length;
      db.blocks = db.blocks.filter((row) => row.blocker_id !== userId && row.blocked_id !== userId);
      return { rows: [], rowCount: before - db.blocks.length };
    }
    if (/\bid = \$1\b/.test(text)) {
      const id = Number(params[0]);
      const restrictsOwner = /blocker_id = \$2/.test(text);
      const owner = restrictsOwner ? Number(params[1]) : null;
      const before = db.blocks.length;
      db.blocks = db.blocks.filter((row) => {
        if (row.id !== id) return true;
        if (restrictsOwner && row.blocker_id !== owner) return true;
        return false;
      });
      return { rows: [], rowCount: before - db.blocks.length };
    }
    return { rows: [], rowCount: 0 };
  }
  if (/^SELECT 1 FROM user_blocks WHERE/.test(text)) {
    return { rows: blockedPair(params[0], params[1]) ? [{ '?column?': 1 }] : [] };
  }
  if (/to_regclass\('public\.user_blocks'\)/.test(text)) {
    return { rows: [{ ready: db.migrated }] };
  }
  if (/AS block_id/.test(text) && /FROM user_blocks/.test(text)) {
    let rows = db.blocks.slice();
    if (/blocker_id = \$1/.test(text)) {
      rows = rows.filter((row) => row.blocker_id === Number(params[0]));
    }
    if (/JOIN users\b/.test(text)) {
      rows = rows.filter((row) => db.users.some((user) => user.id === row.blocked_id));
    }
    if (/created_at DESC/.test(text)) {
      const idDesc = /id DESC/.test(text);
      rows.sort((a, b) => {
        const byTime = new Date(b.created_at) - new Date(a.created_at);
        if (byTime !== 0) return byTime;
        return idDesc ? b.id - a.id : a.id - b.id;
      });
    } else if (/created_at ASC/.test(text)) {
      rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    const limit = text.match(/\bLIMIT\s+(\d+)\b/);
    if (limit) rows = rows.slice(0, Number(limit[1]));
    return {
      rows: rows.map((row) => {
        const user = db.users.find((item) => item.id === row.blocked_id);
        const out = {
          created_at: row.created_at,
          email: 'nao-deve-sair@example.test',
          bio: 'nao-deve-sair',
          avatar_url: 'http://exemplo.test/a.png',
          blocked_id: row.blocked_id,
          user_id: row.blocked_id
        };
        if (/AS block_id/.test(text)) out.block_id = row.id;
        if (/\busername\b/.test(text)) out.username = user ? user.username : null;
        return out;
      })
    };
  }

  if (/^SELECT \* FROM missions m WHERE id = \$1 AND \( m\.user_id = \$2 OR m\.partner_id = \$2 \)$/.test(text)) {
    const mission = missionById(params[0]);
    const userId = Number(params[1]);
    const ok = mission && (Number(mission.user_id) === userId || Number(mission.partner_id) === userId);
    return { rows: ok ? [{ ...mission }] : [] };
  }
  if (/FROM mission_matches mm JOIN missions ma ON ma\.id = mm\.mission_a_id/.test(text)) {
    const mm = activeMatchOf(Number(params[0]));
    if (!mm) return { rows: [] };
    const a = missionById(mm.mission_a_id);
    const b = missionById(mm.mission_b_id);
    return { rows: [{ ...mm, user_a: a.user_id, user_b: b.user_id }] };
  }
  if (/FROM messages m JOIN users u ON m\.sender_id = u\.id WHERE m\.mission_id = ANY/.test(text)) {
    assert.match(text, /m\.created_at >= \$3::timestamp/);
    const ids = params[0].map(Number);
    const people = params[1].map(Number);
    const since = params[2] ? new Date(params[2]).getTime() : null;
    const rows = db.messages.filter((item) => ids.includes(item.mission_id) && people.includes(item.sender_id)
      && (since === null || new Date(item.created_at).getTime() >= since));
    return { rows: rows.map((item) => ({ ...item, sender_name: `pessoa${item.sender_id}` })) };
  }

  if (/^SELECT \* FROM missions WHERE id = \$1 AND user_id = \$2 AND status = 'active' AND mode = 'solo'/.test(text)) {
    const mission = missionById(params[0]);
    const ok = mission && mission.user_id === Number(params[1]) && mission.status === 'active'
      && mission.mode === 'solo' && mission.partner_id == null;
    return { rows: ok ? [{ ...mission }] : [] };
  }
  if (/^SELECT m\.\* FROM missions m WHERE m\.status = 'active' AND m\.mode = 'solo'/.test(text)) {
    const me = Number(params[2]);
    let rows = db.missions.filter((mission) => mission.status === 'active' && mission.mode === 'solo'
      && mission.match_preference === params[0]
      && String(mission.category).toLowerCase() === String(params[1]).toLowerCase()
      && mission.user_id !== me
      && mission.partner_id == null
      && !activeMatchOf(mission.id));
    if (/user_blocks/.test(text)) rows = rows.filter((mission) => !blockedPair(me, mission.user_id));
    return { rows: rows.slice(0, 1).map((mission) => ({ ...mission })) };
  }
  if (/^INSERT INTO mission_matches/.test(text)) {
    const startedAt = /NOW\(\)/.test(text) ? new Date() : new Date(params[3]);
    db.matches.push({
      id: db.matches.length + 1,
      mission_a_id: Number(params[0]),
      mission_b_id: Number(params[1]),
      status: 'active',
      started_at: startedAt
    });
    return { rows: [{ started_at: startedAt }], rowCount: 1 };
  }
  if (/^UPDATE missions SET mode = \$1, partner_id = \$2, pair_started_at = NOW\(\) WHERE id = \$3$/.test(text)) {
    Object.assign(missionById(params[2]), {
      mode: params[0],
      partner_id: Number(params[1]),
      pair_started_at: new Date()
    });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);
let server;
let baseUrl;

async function call(method, url, userId, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : {}
  };
}

describe('lista de bloqueios: ver e desbloquear', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params), {
      missing: (id) => !db.users.some((user) => user.id === id)
    }));
    mock.method(Pool.prototype, 'connect', async () => ({
      query: async (sql, params) => handle(sql, params),
      release() {}
    }));
    for (const name of ['log', 'error', 'warn', 'info', 'debug']) {
      mock.method(console, name, (...args) => { consoleCalls.push(args); });
    }
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetDb();
  });

  test('sem token: 401', async () => {
    db.blocks = [{ id: 501, blocker_id: 10, blocked_id: 11, created_at: '2026-11-24T10:00:00.000Z' }];
    const list = await call('GET', '/api/users/me/blocks');
    const del = await call('DELETE', '/api/users/me/blocks/501');
    assert.equal(list.status, 401);
    assert.equal(del.status, 401);
    assert.equal(list.body.error, 'Acesso negado. Token não fornecido.');
    assert.equal(del.body.error, 'Acesso negado. Token não fornecido.');
    assert.equal(list.body.blocks, undefined);
    assert.equal(del.body.unblocked, undefined);
    assert.equal(db.blocks.length, 1);
    assert.equal(db.queries.length, 0);
    assert.deepEqual(consoleCalls, []);
  });

  test('a lista traz só quem eu bloqueei, nunca quem me bloqueou, nem campos extras', async () => {
    db.blocks = [
      { id: 501, blocker_id: 10, blocked_id: 11, created_at: '2026-11-24T10:00:00.000Z' },
      { id: 502, blocker_id: 10, blocked_id: 12, created_at: '2026-11-25T10:00:00.000Z' },
      { id: 503, blocker_id: 11, blocked_id: 10, created_at: '2026-11-26T10:00:00.000Z' }
    ];
    const mine = await call('GET', '/api/users/me/blocks?userId=11', 10);
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('cache-control'), 'no-store');
    assert.deepEqual(mine.body, {
      blocks: [
        { block_id: 502, username: 'pessoa-doze', created_at: '2026-11-25T10:00:00.000Z' },
        { block_id: 501, username: 'pessoa-onze', created_at: '2026-11-24T10:00:00.000Z' }
      ]
    });
    for (const block of mine.body.blocks) {
      assert.deepEqual(Object.keys(block).sort(), ['block_id', 'created_at', 'username']);
    }
    const theirs = await call('GET', '/api/users/me/blocks', 11);
    assert.deepEqual(theirs.body, {
      blocks: [{ block_id: 503, username: 'pessoa-dez', created_at: '2026-11-26T10:00:00.000Z' }]
    });
    const raw = JSON.stringify(mine.body) + JSON.stringify(theirs.body);
    assert.equal(raw.includes('nao-deve-sair'), false);
    assert.equal(raw.includes('email'), false);
    assert.equal(raw.includes('blocked_id'), false);
    assert.equal(raw.includes('avatar'), false);
    assert.equal(raw.includes('bio'), false);
    const mineQuery = db.queries.find((query) => /AS block_id/.test(query.text) && query.params[0] === 10);
    assert.ok(mineQuery);
    assert.deepEqual(mineQuery.params, [10]);
    assert.match(mineQuery.text, /WHERE b\.blocker_id = \$1/);
    assert.match(mineQuery.text, /ORDER BY b\.created_at DESC/);
    assert.match(mineQuery.text, /LIMIT 100/);
    assert.doesNotMatch(mineQuery.text, /email|bio|avatar|password/);
    assert.deepEqual(consoleCalls, []);
  });

  test('ordem do mais recente para o mais antigo', async () => {
    const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    for (let i = 1; i <= 101; i += 1) {
      const userId = 1000 + i;
      db.users.push({ id: userId, username: `pessoa-${userId}`, password: HASH });
      db.blocks.push({ id: i, blocker_id: 10, blocked_id: userId, created_at: at(i) });
    }
    db.blocks.push({ id: 900, blocker_id: 11, blocked_id: 10, created_at: '2026-06-01T00:00:00.000Z' });
    const res = await call('GET', '/api/users/me/blocks', 10);
    assert.equal(res.status, 200);
    assert.equal(res.body.blocks.length, 100);
    assert.equal(res.body.blocks[0].block_id, 101);
    assert.equal(res.body.blocks[0].username, 'pessoa-1101');
    assert.equal(res.body.blocks[0].created_at, at(101));
    assert.equal(res.body.blocks[99].block_id, 2);
    assert.equal(res.body.blocks[99].created_at, at(2));
    const times = res.body.blocks.map((block) => new Date(block.created_at).getTime());
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i - 1] > times[i]);
    assert.equal(res.body.blocks.some((block) => block.block_id === 1 || block.block_id === 900), false);
    assert.equal(res.body.blocks.some((block) => block.username === 'pessoa-onze'), false);
    assert.equal(JSON.stringify(res.body).includes('nao-deve-sair'), false);
    assert.deepEqual(consoleCalls, []);
  });

  test('não consigo desbloquear a linha de outra pessoa: 200 e a linha dela continua', async () => {
    db.blocks = [
      { id: 501, blocker_id: 10, blocked_id: 11, created_at: '2026-11-24T10:00:00.000Z' },
      { id: 503, blocker_id: 11, blocked_id: 10, created_at: '2026-11-26T10:00:00.000Z' }
    ];
    const res = await call('DELETE', '/api/users/me/blocks/503', 10);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { unblocked: true });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(db.blocks.map((row) => row.id), [501, 503]);
    const del = db.queries.find((query) => query.text.startsWith('DELETE FROM user_blocks'));
    assert.deepEqual(del.params, [503, 10]);
    assert.match(del.text, /blocker_id = \$2/);
    const theirs = await call('GET', '/api/users/me/blocks', 11);
    assert.equal(theirs.body.blocks[0].block_id, 503);
    assert.deepEqual(consoleCalls, []);
  });

  test('desbloquear duas vezes: 200 nas duas', async () => {
    db.blocks = [
      { id: 501, blocker_id: 10, blocked_id: 11, created_at: '2026-11-24T10:00:00.000Z' },
      { id: 503, blocker_id: 11, blocked_id: 10, created_at: '2026-11-26T10:00:00.000Z' }
    ];
    const first = await call('DELETE', '/api/users/me/blocks/501', 10);
    const second = await call('DELETE', '/api/users/me/blocks/501', 10);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.body, { unblocked: true });
    assert.deepEqual(second.body, { unblocked: true });
    assert.deepEqual(db.blocks.map((row) => row.id), [503]);
    const missing = await call('DELETE', '/api/users/me/blocks/424242', 10);
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { unblocked: true });
    assert.deepEqual(db.blocks.map((row) => row.id), [503]);
    assert.deepEqual(consoleCalls, []);
  });

  test('id inválido: 400', async () => {
    db.blocks = [{ id: 501, blocker_id: 10, blocked_id: 11, created_at: '2026-11-24T10:00:00.000Z' }];
    for (const bad of ['abc', '0', '-1', '01', '1.5', '1e2', '2147483648', '9999999999']) {
      const res = await call('DELETE', `/api/users/me/blocks/${bad}`, 10);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error, 'O identificador do bloqueio não é válido.');
      assert.equal(res.body.unblocked, undefined);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(db.blocks.length, 1);
    assert.equal(db.queries.some((query) => /user_blocks/.test(query.text)), false);
    assert.deepEqual(consoleCalls, []);
  });

  test('sem a 011: 503 nas duas rotas', async () => {
    db.migrated = false;
    db.blocks = [{ id: 501, blocker_id: 10, blocked_id: 11, created_at: '2026-11-24T10:00:00.000Z' }];
    const list = await call('GET', '/api/users/me/blocks', 10);
    const del = await call('DELETE', '/api/users/me/blocks/501', 10);
    assert.equal(list.status, 503);
    assert.equal(del.status, 503);
    assert.equal(list.body.error, 'A lista de bloqueios ainda não está disponível. Tente de novo mais tarde.');
    assert.equal(del.body.error, 'O desbloqueio ainda não está disponível. Tente de novo mais tarde.');
    assert.equal(list.body.blocks, undefined);
    assert.equal(del.body.unblocked, undefined);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal(del.headers.get('cache-control'), 'no-store');
    assert.equal(db.blocks.length, 1);
    assert.deepEqual(consoleCalls, []);
  });

  test('depois de desbloquear, o par volta a ser possível, salvo se houver bloqueio no outro sentido', async () => {
    duoMissions();
    db.blocks = [{ id: 501, blocker_id: 10, blocked_id: 11, created_at: '2026-11-24T10:00:00.000Z' }];
    assert.equal(await tryMatchMission(missionById(100), 10, {
      connect: async () => ({ query: async (sql, params) => handle(sql, params), release() {} })
    }), null, 'com o meu bloqueio o par não sai');

    const mine = await call('DELETE', '/api/users/me/blocks/501', 10);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, { unblocked: true });
    const paired = await tryMatchMission(missionById(100), 10, {
      connect: async () => ({ query: async (sql, params) => handle(sql, params), release() {} })
    });
    assert.ok(paired, 'sem bloqueio os dois voltam a poder formar par');
    assert.equal(paired.partnerMission.user_id, 11);

    soloAgain();
    db.blocks.push({ id: 503, blocker_id: 11, blocked_id: 10, created_at: '2026-11-26T10:00:00.000Z' });
    const pool = { connect: async () => ({ query: async (sql, params) => handle(sql, params), release() {} }) };
    assert.equal(await tryMatchMission(missionById(100), 10, pool), null, 'o bloqueio no outro sentido continua');
    const notMine = await call('DELETE', '/api/users/me/blocks/503', 10);
    assert.equal(notMine.status, 200);
    assert.equal(db.blocks.some((row) => row.id === 503), true);
    assert.equal(await tryMatchMission(missionById(100), 10, pool), null);

    const other = await call('DELETE', '/api/users/me/blocks/503', 11);
    assert.equal(other.status, 200);
    assert.equal(db.blocks.some((row) => row.id === 503), false);
    const again = await tryMatchMission(missionById(100), 10, pool);
    assert.ok(again);
    assert.equal(again.partnerMission.user_id, 11);
    assert.deepEqual(consoleCalls, []);
  });

  test('a conversa antiga continua sem aparecer', async () => {
    duoMissions();
    const oldAt = new Date('2020-01-02T00:00:00.000Z');
    db.matches = [{ id: 1, mission_a_id: 100, mission_b_id: 101, status: 'ended', started_at: new Date('2020-01-01T00:00:00.000Z') }];
    db.messages = [
      { id: 1, mission_id: 100, sender_id: 10, content: 'conversa-antiga-a', created_at: oldAt },
      { id: 2, mission_id: 101, sender_id: 11, content: 'conversa-antiga-b', created_at: oldAt }
    ];
    db.blocks = [{ id: 7, blocker_id: 10, blocked_id: 11, created_at: '2020-01-03T00:00:00.000Z' }];

    const unblocked = await call('DELETE', '/api/users/me/blocks/7', 10);
    assert.equal(unblocked.status, 200);
    const pool = { connect: async () => ({ query: async (sql, params) => handle(sql, params), release() {} }) };
    const paired = await tryMatchMission(missionById(100), 10, pool);
    assert.ok(paired);
    const active = db.matches.find((mm) => mm.status === 'active');
    assert.ok(active.started_at.getTime() > oldAt.getTime());
    db.messages.push({
      id: 3,
      mission_id: 100,
      sender_id: 10,
      content: 'conversa-nova',
      created_at: new Date(active.started_at.getTime() + 5000)
    });

    for (const [missionId, userId] of [[100, 10], [101, 11]]) {
      const res = await call('GET', `/api/messages/${missionId}`, userId);
      assert.equal(res.status, 200, `missão ${missionId}`);
      assert.deepEqual(res.body.messages.map((item) => item.id), [3]);
      assert.equal(JSON.stringify(res.body).includes('conversa-antiga'), false);
      assert.equal(JSON.stringify(res.body).includes('conversa-nova'), true);
    }
    assert.equal(db.messages.length, 3, 'nada da conversa antiga foi apagado');
    assert.deepEqual(consoleCalls, []);
  });

  test('apagar a conta tira as linhas', async () => {
    db.blocks = [
      { id: 1, blocker_id: 10, blocked_id: 11, created_at: '2026-11-01T00:00:00.000Z' },
      { id: 2, blocker_id: 11, blocked_id: 10, created_at: '2026-11-02T00:00:00.000Z' },
      { id: 3, blocker_id: 11, blocked_id: 12, created_at: '2026-11-03T00:00:00.000Z' }
    ];
    const res = await call('DELETE', '/api/users/me', 10, { password: PASSWORD });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: true });
    assert.deepEqual(db.blocks.map((row) => row.id), [3]);
    assert.equal(db.users.some((user) => user.id === 10), false);
    assert.equal(db.users.some((user) => user.id === 11), true);
    const removal = db.queries.filter((query) => query.text.startsWith('DELETE FROM user_blocks'));
    assert.equal(removal.length, 1);
    assert.match(removal[0].text, /blocker_id = \$1 OR blocked_id = \$1/);
    assert.deepEqual(removal[0].params, [10]);
    assert.equal(JSON.stringify(consoleCalls).includes(PASSWORD), false);
    assert.deepEqual(consoleCalls, []);
  });

  test('429 acima do limite', async () => {
    assert.equal(BLOCK_LIST_GET_LIMIT, 30);
    assert.equal(BLOCK_LIST_GET_WINDOW_MS, 60 * 1000);
    assert.equal(BLOCK_LIST_DELETE_LIMIT, 10);
    assert.equal(BLOCK_LIST_DELETE_WINDOW_MS, 60 * 60 * 1000);

    const realNow = Date.now;
    let now = 1700000000000;
    Date.now = () => now;
    try {
      for (let i = 0; i < BLOCK_LIST_DELETE_LIMIT; i += 1) {
        const res = await call('DELETE', '/api/users/me/blocks/abc', 13);
        assert.equal(res.status, 400, `id inválido ${i + 1} ainda entra na cota`);
      }
      const overInvalid = await call('DELETE', '/api/users/me/blocks/abc', 13);
      assert.equal(overInvalid.status, 429);
      assert.equal(overInvalid.headers.get('retry-after'), '3600');
      assert.equal(overInvalid.body.error, 'Você pediu muitos desbloqueios nesta hora. Tente de novo mais tarde.');
      assert.equal(overInvalid.body.code, 'too_many_requests');
      assert.equal(overInvalid.headers.get('cache-control'), 'no-store');
      assert.equal(db.queries.some((query) => /user_blocks/.test(query.text)), false);

      for (let i = 0; i < BLOCK_LIST_GET_LIMIT; i += 1) {
        const res = await call('GET', '/api/users/me/blocks', 10);
        assert.equal(res.status, 200, `leitura ${i + 1}`);
        assert.deepEqual(res.body, { blocks: [] });
      }
      const readsBefore = db.queries.filter((query) => /AS block_id/.test(query.text)).length;
      const over = await call('GET', '/api/users/me/blocks', 10);
      assert.equal(over.status, 429);
      assert.equal(over.headers.get('retry-after'), '60');
      assert.equal(over.body.error, 'Você consultou a lista muitas vezes. Espere um minuto e tente de novo.');
      assert.equal(over.body.blocks, undefined);
      assert.equal(over.headers.get('cache-control'), 'no-store');
      assert.equal(db.queries.filter((query) => /AS block_id/.test(query.text)).length, readsBefore);
      assert.equal((await call('GET', '/api/users/me/blocks', 11)).status, 200, 'o limite é por pessoa');

      now += BLOCK_LIST_GET_WINDOW_MS;
      assert.equal((await call('GET', '/api/users/me/blocks', 10)).status, 200);

      for (let i = 0; i < BLOCK_LIST_DELETE_LIMIT; i += 1) {
        const res = await call('DELETE', '/api/users/me/blocks/999', 10);
        assert.equal(res.status, 200, `desbloqueio ${i + 1}`);
        assert.deepEqual(res.body, { unblocked: true });
      }
      const overDelete = await call('DELETE', '/api/users/me/blocks/999', 10);
      assert.equal(overDelete.status, 429);
      assert.equal(overDelete.headers.get('retry-after'), '3600');
      assert.equal(overDelete.body.unblocked, undefined);
      assert.equal((await call('DELETE', '/api/users/me/blocks/999', 12)).status, 200, 'outra pessoa não herda a cota');

      now += BLOCK_LIST_DELETE_WINDOW_MS;
      assert.equal((await call('DELETE', '/api/users/me/blocks/999', 10)).status, 200);
      assert.deepEqual(consoleCalls, []);
    } finally {
      Date.now = realNow;
    }
  });
});
