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
const { ACCOUNT_DELETION_STEPS, TRANSFERRED_MISSION_TITLE } = require('../lib/account-deletion');
const { resetAllAttempts, MAX_WRONG } = require('../lib/password-attempts');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

const PASSWORD_A = 'senha-certa-de-a';
const PASSWORD_B = 'senha-certa-de-b';
const HASH_A = bcrypt.hashSync(PASSWORD_A, 4);
const HASH_B = bcrypt.hashSync(PASSWORD_B, 4);

const state = { users: new Map(), queries: [], failAt: null, released: 0, dbDown: false };
const logged = [];

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function resetState() {
  state.users = new Map([
    [2, { id: 2, username: 'alfa', email: 'alfa@exemplo.test', password: HASH_A }],
    [3, { id: 3, username: 'beta', email: 'beta@exemplo.test', password: HASH_B }],
    [4, { id: 4, username: 'gama', email: 'gama@exemplo.test', password: HASH_A }],
    [1, { id: 1, username: 'admin', email: 'admin@exemplo.test', password: HASH_A }]
  ]);
  state.dbDown = false;
  resetAllAttempts();
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
  if (state.dbDown) {
    const err = new Error('connect ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    return Promise.reject(err);
  }
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
    assert.equal(state.users.size, 4);
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
    // A conta ainda existe: a sessão segue valendo.
    const me = await request('GET', '/api/users/me', { token: tokenFor(3) });
    assert.equal(me.status, 200);
  });
});

describe('excluir a conta: segurança', { concurrency: 1 }, () => {
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

  test('token de conta apagada é recusado sem lista na memória (conta sumiu do banco)', async () => {
    // Simula outro processo ou um reinício: a conta some do banco sem passar
    // por esta rota.
    state.users.delete(3);
    const me = await request('GET', '/api/users/me', { token: tokenFor(3) });
    assert.equal(me.status, 401);
    assert.equal(me.body.code, 'session_ended');
    const del = await request('DELETE', '/api/users/me', { token: tokenFor(3), body: { password: PASSWORD_B } });
    assert.equal(del.status, 401);
    assert.equal(writes().length, 0);
  });

  test('banco fora: 503 e o pedido não passa (falha fechado)', async () => {
    state.dbDown = true;
    const me = await request('GET', '/api/users/me', { token: tokenFor(2) });
    assert.equal(me.status, 503);
    assert.equal(me.body.code, 'auth_unavailable');
    const del = await request('DELETE', '/api/users/me', { token: tokenFor(2), body: { password: PASSWORD_A } });
    assert.equal(del.status, 503);
    assert.equal(state.users.has(2), true);
    assert.equal(writes().length, 0);
  });

  test('token com id que não é número: 401 sem consultar o banco', async () => {
    const me = await request('GET', '/api/users/me', { token: jwt.sign({ userId: 'abc' }, process.env.JWT_SECRET) });
    assert.equal(me.status, 401);
    assert.equal(state.queries.length, 0);
  });

  test('admin não exclui a própria conta por esta rota (403), nem com a senha certa', async () => {
    const res = await request('DELETE', '/api/users/me', { token: tokenFor(1), body: { password: PASSWORD_A } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'admin_account');
    assert.equal(state.users.has(1), true);
    assert.equal(writes().length, 0);
  });

  test(`excesso de tentativas: na ${MAX_WRONG}.ª senha errada bloqueia, e a certa também fica bloqueada`, async () => {
    for (let i = 1; i < MAX_WRONG; i += 1) {
      const wrong = await request('DELETE', '/api/users/me', { token: tokenFor(2), body: { password: `errada-${i}` } });
      assert.equal(wrong.status, 403, `tentativa ${i}`);
    }
    const last = await request('DELETE', '/api/users/me', { token: tokenFor(2), body: { password: 'errada-final' } });
    assert.equal(last.status, 429);
    assert.equal(last.body.code, 'too_many_attempts');
    const right = await request('DELETE', '/api/users/me', { token: tokenFor(2), body: { password: PASSWORD_A } });
    assert.equal(right.status, 429);
    assert.equal(state.users.has(2), true);
    assert.equal(writes().length, 0);
    // A trava é por conta: outra pessoa segue podendo.
    const other = await request('DELETE', '/api/users/me', { token: tokenFor(3), body: { password: 'errada' } });
    assert.equal(other.status, 403);
  });

  test('senha certa antes do limite zera a contagem', async () => {
    for (let i = 1; i < MAX_WRONG; i += 1) {
      await request('DELETE', '/api/users/me', { token: tokenFor(4), body: { password: `errada-${i}` } });
    }
    const ok = await request('DELETE', '/api/users/me', { token: tokenFor(4), body: { password: PASSWORD_A } });
    assert.equal(ok.status, 200);
  });
});

// Colunas que apontam para users: em CREATE TABLE e em ALTER TABLE ... ADD
// COLUMN (achado do Argos no PR 26: a guarda só via o CREATE TABLE).
function userReferenceColumns(sqlText) {
  const found = [];
  const clean = sqlText.replace(/--[^\n]*/g, '');
  for (const [, table, body] of clean.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\s*\);/g)) {
    for (const [, column] of body.matchAll(/^\s*(\w+) [^,\n]*REFERENCES users\s*\(id\)/gm)) {
      found.push({ table, column });
    }
  }
  for (const [, table, body] of clean.matchAll(/ALTER TABLE(?: IF EXISTS)?(?: ONLY)? (\w+)([\s\S]*?);/g)) {
    for (const [, column] of body.matchAll(/ADD(?: COLUMN)?(?: IF NOT EXISTS)? (\w+) [^,;]*?REFERENCES users\s*\(id\)/g)) {
      found.push({ table, column });
    }
  }
  return found;
}

describe('lista de exclusão cobre o banco', () => {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const sql = fs.readdirSync(migrationsDir)
    .filter(name => name.endsWith('.sql'))
    .map(name => fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
    .join('\n');
  const stepsSql = ACCOUNT_DELETION_STEPS.map(step => normalize(step.sql)).join('\n');

  function covered(table, column) {
    return new RegExp(`(FROM|UPDATE) ${table}\\b[^\\n]*?\\b${column} = \\$1`).test(stepsSql);
  }

  test('a guarda vê CREATE TABLE e ALTER TABLE ... ADD COLUMN', () => {
    const fake = `
      CREATE TABLE IF NOT EXISTS coisa (
        id SERIAL PRIMARY KEY,
        dono_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      ALTER TABLE missions
        ADD COLUMN IF NOT EXISTS revisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS outra TEXT;
      ALTER TABLE checkins ADD COLUMN visto_por INTEGER REFERENCES users (id);
    `;
    assert.deepEqual(userReferenceColumns(fake), [
      { table: 'coisa', column: 'dono_id' },
      { table: 'missions', column: 'revisor_id' },
      { table: 'checkins', column: 'visto_por' }
    ]);
    assert.equal(covered('missions', 'revisor_id'), false);
  });

  test('toda coluna que aponta para users tem um passo na exclusão', () => {
    const columns = userReferenceColumns(sql).filter(item => item.table !== 'users');
    assert.ok(columns.length >= 10);
    for (const { table, column } of columns) {
      assert.ok(covered(table, column), `${table}.${column} sem passo na exclusão`);
    }
  });

  test('a conta sai por último', () => {
    assert.equal(normalize(ACCOUNT_DELETION_STEPS[ACCOUNT_DELETION_STEPS.length - 1].sql), 'DELETE FROM users WHERE id = $1');
  });

  test('ordem: pares antes da troca de dono; troca de dono antes de apagar registros e missões', () => {
    const at = name => ACCOUNT_DELETION_STEPS.findIndex(step => step.name === name);
    const transfer = at('missoes_passadas_ao_parceiro');
    assert.ok(transfer > 0);
    assert.ok(at('missao_do_outro_lado_do_par') < at('pares_das_missoes'));
    assert.ok(at('pares_das_missoes') < transfer);
    for (const later of ['fusoes_apontando_para_as_missoes', 'checkins', 'mensagens', 'registro_de_avisos', 'missoes', 'conta']) {
      assert.ok(transfer < at(later), `${later} antes da troca de dono`);
    }
  });

  test('troca de dono: contrato de quem saiu vira NULL, título neutro, parceiro zerado, started_at fica', () => {
    const transfer = normalize(ACCOUNT_DELETION_STEPS.find(step => step.name === 'missoes_passadas_ao_parceiro').sql);
    for (const field of ['description', 'daily_minimum', 'commitment_window', 'why_it_matters', 'fallback_plan',
      'study_focus', 'study_current_stage', 'study_target_outcome', 'partner_id', 'partner_contact',
      'partner_started_at', 'pair_started_at', 'match_preference']) {
      assert.match(transfer, new RegExp(`\\b${field} = NULL`), field);
    }
    assert.match(transfer, /user_id = partner_id/);
    assert.match(transfer, /user_score = partner_score/);
    assert.match(transfer, /user_contact = partner_contact/);
    assert.match(transfer, /mode = 'solo'/);
    assert.ok(transfer.includes(`title = '${TRANSFERRED_MISSION_TITLE}'`));
    assert.doesNotMatch(transfer, /started_at = (?!NULL)/);
    assert.match(transfer, /WHERE user_id = \$1 AND partner_id IS NOT NULL/);
  });

  test('o outro lado do par só muda em par ativo', () => {
    const other = normalize(ACCOUNT_DELETION_STEPS.find(step => step.name === 'missao_do_outro_lado_do_par').sql);
    assert.match(other, /mm\.status = 'active'/);
    assert.match(other, /mode = 'solo'/);
  });
});
