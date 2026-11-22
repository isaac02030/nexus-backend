// Excluir a conta: DELETE /api/users/me (banco simulado, sem banco real).
// A prova com Postgres de verdade ficou fora do repositório (ver o PR).
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const usersRouter = require('../routes/users');
const { ACCOUNT_DELETION_STEPS } = require('../lib/account-deletion');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

const PASSWORD_A = 'senha-certa-de-a';
const PASSWORD_B = 'senha-certa-de-b';
const HASH_A = bcrypt.hashSync(PASSWORD_A, 4);
const HASH_B = bcrypt.hashSync(PASSWORD_B, 4);

const state = { users: new Map(), queries: [], failAt: null, released: 0 };
const logged = [];

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function resetState() {
  state.users = new Map([
    [2, { id: 2, username: 'alfa', email: 'alfa@exemplo.test', password: HASH_A }],
    [3, { id: 3, username: 'beta', email: 'beta@exemplo.test', password: HASH_B }],
    [4, { id: 4, username: 'gama', email: 'gama@exemplo.test', password: HASH_A }]
  ]);
  state.queries = [];
  state.failAt = null;
  state.released = 0;
  logged.length = 0;
}

// Transação simulada: os DELETE de users só valem no COMMIT.
function makeClient() {
  let pendingDeletes = [];
  return {
    query(sql, params = []) {
      const text = normalize(sql);
      state.queries.push({ text, params });
      if (state.failAt && text.includes(state.failAt)) {
        const err = new Error('falha simulada com texto nota-secreta');
        err.code = 'XX000';
        throw err;
      }
      if (text === 'BEGIN' || text === 'ROLLBACK') { pendingDeletes = []; return { rows: [] }; }
      if (text === 'COMMIT') {
        for (const id of pendingDeletes) state.users.delete(id);
        pendingDeletes = [];
        return { rows: [] };
      }
      if (/^SELECT id, password FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) {
        const user = state.users.get(Number(params[0]));
        return { rows: user ? [{ id: user.id, password: user.password }] : [] };
      }
      if (/^DELETE FROM users WHERE id = \$1$/.test(text)) {
        pendingDeletes.push(Number(params[0]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { state.released += 1; }
  };
}

function poolQuery(sql, params = []) {
  const text = normalize(sql);
  state.queries.push({ text, params, pool: true });
  if (/^SELECT \* FROM users WHERE email = \$1$/.test(text)) {
    const user = [...state.users.values()].find(item => item.email === params[0]);
    return { rows: user ? [{ ...user }] : [] };
  }
  if (/FROM users WHERE id = \$1/.test(text)) {
    const user = state.users.get(Number(params[0]));
    return { rows: user ? [{ id: user.id, username: user.username, email: user.email }] : [] };
  }
  return { rows: [] };
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

function writes() {
  return state.queries.filter(item => /^(DELETE|UPDATE|INSERT)/i.test(item.text));
}

let server;
let baseUrl;

async function request(method, urlPath, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { 'Content-Type': 'application/json' })
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, raw, body: raw ? JSON.parse(raw) : {} };
}

describe('excluir a conta', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', (sql, params) => poolQuery(sql, params));
    mock.method(Pool.prototype, 'connect', async () => makeClient());
    mock.method(console, 'error', (...args) => { logged.push(args.map(String).join(' ')); });
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(resetState);

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('sem login: 401 e nada muda', async () => {
    const res = await request('DELETE', '/api/users/me', { body: { password: PASSWORD_A } });
    assert.equal(res.status, 401);
    assert.equal(writes().length, 0);
    assert.equal(state.users.size, 3);
  });

  test('sem senha: 400 e nada muda', async () => {
    const res = await request('DELETE', '/api/users/me', { token: tokenFor(2), body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'password_required');
    assert.equal(writes().length, 0);
  });

  test('senha errada: 403, mensagem calma e nada apagado', async () => {
    const res = await request('DELETE', '/api/users/me', { token: tokenFor(2), body: { password: 'errada' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'wrong_password');
    assert.equal(res.body.error, 'Senha incorreta. Sua conta não foi excluída.');
    assert.equal(writes().length, 0);
    assert.ok(state.queries.some(item => item.text === 'ROLLBACK'));
    assert.equal(state.users.has(2), true);
    assert.equal(state.released, 1);
  });

  test('outra pessoa não apaga a sua conta: com a senha de A no token de B, nada muda', async () => {
    const res = await request('DELETE', '/api/users/me', {
      token: tokenFor(3),
      body: { password: PASSWORD_A, user_id: 2, id: 2 }
    });
    assert.equal(res.status, 403);
    assert.equal(writes().length, 0);
    assert.equal(state.users.has(2), true);
    assert.equal(state.users.has(3), true);
  });

  test('com a senha certa: todos os passos, só com o id de quem pede, numa transação', async () => {
    const res = await request('DELETE', '/api/users/me', {
      token: tokenFor(2),
      body: { password: PASSWORD_A, user_id: 3 }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: true });

    const texts = state.queries.filter(item => !item.pool).map(item => item.text);
    assert.equal(texts[0], 'BEGIN');
    assert.equal(texts[texts.length - 1], 'COMMIT');
    const steps = state.queries.filter(item => /^(DELETE|UPDATE)/.test(item.text));
    assert.deepEqual(steps.map(item => item.text), ACCOUNT_DELETION_STEPS.map(step => normalize(step.sql)));
    for (const step of steps) assert.deepEqual(step.params, [2]);
    assert.equal(state.users.has(2), false);
    assert.equal(state.users.has(3), true);
    assert.equal(state.released, 1);
  });

  // As sessões encerradas ficam na memória do processo: cada teste que
  // apaga usa uma conta diferente.
  test('depois de apagar: o login falha, o token antigo não vale e a outra pessoa segue', async () => {
    const del = await request('DELETE', '/api/users/me', { token: tokenFor(4), body: { password: PASSWORD_A } });
    assert.equal(del.status, 200);

    const login = await request('POST', '/api/users/login', {
      body: { email: 'gama@exemplo.test', password: PASSWORD_A }
    });
    assert.equal(login.status, 401);

    const reuse = await request('GET', '/api/users/me', { token: tokenFor(4) });
    assert.equal(reuse.status, 401);

    const again = await request('DELETE', '/api/users/me', { token: tokenFor(4), body: { password: PASSWORD_A } });
    assert.equal(again.status, 401);

    const other = await request('GET', '/api/users/me', { token: tokenFor(3) });
    assert.equal(other.status, 200);
  });

  test('falha no meio: ROLLBACK, 500 calmo, conta continua e o log não traz texto', async () => {
    state.failAt = 'DELETE FROM community_posts';
    const res = await request('DELETE', '/api/users/me', { token: tokenFor(3), body: { password: PASSWORD_B } });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Não foi possível excluir agora. Tente de novo.');
    assert.ok(state.queries.some(item => item.text === 'ROLLBACK'));
    assert.equal(state.queries.some(item => item.text === 'COMMIT'), false);
    assert.equal(state.users.has(3), true);
    assert.equal(res.raw.includes('nota-secreta'), false);
    assert.equal(logged.join('\n').includes('nota-secreta'), false);
    assert.equal(logged.join('\n').includes(PASSWORD_B), false);
    // A sessão não foi encerrada: a conta ainda existe.
    const me = await request('GET', '/api/users/me', { token: tokenFor(3) });
    assert.equal(me.status, 200);
  });
});

describe('lista de exclusão cobre o banco', () => {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const sql = fs.readdirSync(migrationsDir)
    .filter(name => name.endsWith('.sql'))
    .map(name => fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
    .join('\n');
  const stepsSql = ACCOUNT_DELETION_STEPS.map(step => normalize(step.sql)).join('\n');

  test('toda tabela com coluna que aponta para users tem um passo na exclusão', () => {
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)];
    assert.ok(tables.length >= 10);
    for (const [, table, body] of tables) {
      const userColumns = [...body.matchAll(/^\s*(\w+) INTEGER[^,\n]*REFERENCES users\(id\)/gm)].map(m => m[1]);
      if (table === 'users') continue;
      for (const column of userColumns) {
        const pattern = new RegExp(`(FROM|UPDATE) ${table}\\b[^\\n]*?\\b${column} = \\$1`);
        assert.ok(pattern.test(stepsSql), `${table}.${column} sem passo na exclusão`);
      }
    }
  });

  test('a conta sai por último e ninguém usa o ON DELETE sozinho', () => {
    assert.equal(normalize(ACCOUNT_DELETION_STEPS[ACCOUNT_DELETION_STEPS.length - 1].sql), 'DELETE FROM users WHERE id = $1');
  });
});
