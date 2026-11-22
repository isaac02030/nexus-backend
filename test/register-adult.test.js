// Idade no cadastro (T4): só maiores de 18; a data de nascimento não é
// guardada nem logada. Banco simulado: nada de banco real nem segredos.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const usersRouter = require('../routes/users');
const { checkAdult, todayAtLatestZone } = require('../lib/adult-age');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

const db = { queries: [], users: [], missingColumn: false };

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (/^ALTER TABLE users/i.test(text)) return { rows: [] };

  if (/^INSERT INTO users/i.test(text)) {
    if (db.missingColumn) {
      const err = new Error('coluna não existe');
      err.code = '42703';
      throw err;
    }
    const row = {
      id: db.users.length + 7,
      username: params[0],
      email: params[1],
      bio: null,
      avatar_url: null,
      created_at: '2026-11-21T10:00:00Z',
      updated_at: '2026-11-21T10:00:00Z',
      adult_confirmed: /adult_confirmed_at/.test(text) && /NOW\(\)/.test(text)
    };
    db.users.push({ ...row, adult_confirmed_at: row.adult_confirmed ? 'agora' : null });
    return { rows: [row], rowCount: 1 };
  }

  if (/FROM users WHERE id = \$1/i.test(text) && /adult_confirmed/.test(text)) {
    const u = db.users.find((item) => item.id === Number(params[0]));
    if (!u) return { rows: [] };
    return { rows: [{ id: u.id, username: u.username, email: u.email, adult_confirmed: u.adult_confirmed_at != null }] };
  }

  return { rows: [] };
}

function yearsAgo(years, deltaDays = 0) {
  const t = todayAtLatestZone();
  const d = new Date(Date.UTC(t.y - years, t.m - 1, t.d + deltaDays));
  return d.toISOString().slice(0, 10);
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

function register(birthDate, extra = {}) {
  // Aceite da versão atual (migração 008); os casos sem aceite ficam em
  // test/legal-acceptance.test.js.
  const body = {
    username: 'pessoa_teste',
    email: 'pessoa@exemplo.test',
    password: 'senha-de-teste',
    terms_version: 'beta-1',
    privacy_version: 'beta-1',
    ...extra
  };
  if (birthDate !== undefined) body.birth_date = birthDate;
  return request('POST', '/api/users/register', { body });
}

function insertedUser() {
  return db.queries.some((q) => /^INSERT INTO users/i.test(q.text));
}

function birthReachedDb(value) {
  return db.queries.some((q) => q.text.includes(value) || q.params.some((p) => String(p).includes(value)));
}

describe('lib/adult-age: conta da idade', () => {
  const now = new Date('2026-11-21T12:00:00Z'); // em UTC-12: 2026-11-21 00:00

  test('18 anos hoje passa; um dia antes não', () => {
    assert.equal(checkAdult('2008-11-21', now).ok, true);
    const under = checkAdult('2008-11-22', now);
    assert.equal(under.ok, false);
    assert.equal(under.status, 403);
    assert.equal(under.under_age, true);
  });

  test('o corte usa o fuso mais atrasado (UTC-12)', () => {
    // 11:00 UTC de 21/11 ainda é 20/11 em UTC-12: o aniversário de 21/11 não chegou.
    const early = new Date('2026-11-21T11:00:00Z');
    assert.equal(checkAdult('2008-11-21', early).ok, false);
    assert.equal(checkAdult('2008-11-20', early).ok, true);
  });

  test('nascido em 29/02 faz 18 em 01/03 em ano sem 29/02', () => {
    assert.equal(checkAdult('2008-02-29', new Date('2026-02-28T23:00:00Z')).ok, false);
    assert.equal(checkAdult('2008-02-29', new Date('2026-03-01T13:00:00Z')).ok, true);
  });

  test('datas inválidas: 400 com mensagem calma', () => {
    for (const value of ['2001-02-30', '2001-13-01', '15/03/2000', '2000-3-5', 'ontem', 20000101, '1899-12-31', '2027-01-01']) {
      const r = checkAdult(value, now);
      assert.equal(r.ok, false, String(value));
      assert.equal(r.status, 400, String(value));
      assert.match(r.error, /não parece certa/);
    }
    assert.match(checkAdult(undefined, now).error, /Falta a data de nascimento/);
    assert.match(checkAdult('', now).error, /Falta a data de nascimento/);
  });
});

describe('cadastro com idade', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
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
    db.queries = [];
    db.users = [];
    db.missingColumn = false;
    consoleCalls.length = 0;
  });

  test('maior de 18: cria a conta e guarda só a hora da confirmação', async () => {
    const birth = yearsAgo(30);
    const res = await register(birth);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.adult_confirmed, true);
    assert.ok(res.body.token);
    const insert = db.queries.find((q) => /^INSERT INTO users/i.test(q.text));
    assert.match(insert.text, /adult_confirmed_at/);
    assert.match(insert.text, /NOW\(\)/);
    assert.equal(insert.params.length, 5, 'só usuário, e-mail, hash e as duas versões aceitas');
    assert.deepEqual(insert.params.slice(3), ['beta-1', 'beta-1']);
    assert.equal(birthReachedDb(birth), false, 'a data de nascimento não chega ao banco');
    assert.equal(JSON.stringify(res.body).includes(birth), false);
    assert.equal(consoleCalls.length, 0);
  });

  test('negado: menor de 18 recebe 403 calmo e nada é gravado', async () => {
    const birth = yearsAgo(18, 1);
    const res = await register(birth);
    assert.equal(res.status, 403);
    assert.equal(res.body.under_age, true);
    assert.match(res.body.error, /só para maiores de 18 anos/);
    assert.match(res.body.error, /Nada do que você escreveu foi guardado/);
    assert.equal(db.queries.length, 0, 'nenhuma consulta ao banco');
    assert.equal(consoleCalls.length, 0);
  });

  test('negado: criança de 12 anos', async () => {
    const res = await register(yearsAgo(12));
    assert.equal(res.status, 403);
    assert.equal(insertedUser(), false);
  });

  test('exatamente 18 anos hoje: cria a conta', async () => {
    const res = await register(yearsAgo(18));
    assert.equal(res.status, 201);
  });

  test('sem data de nascimento: 400 e nada gravado', async () => {
    const res = await register(undefined);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Falta a data de nascimento/);
    assert.equal(insertedUser(), false);
  });

  test('data inválida ou no futuro: 400 e nada gravado', async () => {
    for (const value of ['2001-02-30', '15/03/2000', yearsAgo(-1), { y: 2000 }]) {
      const res = await register(value);
      assert.equal(res.status, 400, JSON.stringify(value));
      assert.equal(insertedUser(), false);
    }
  });

  test('os campos antigos continuam obrigatórios antes da idade', async () => {
    const res = await request('POST', '/api/users/register', { body: { birth_date: yearsAgo(30) } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Todos os campos/);
  });

  test('migração 006 não aplicada: 503 calmo, sem conta criada', async () => {
    db.missingColumn = true;
    const res = await register(yearsAgo(30));
    assert.equal(res.status, 503);
    assert.match(res.body.error, /não está disponível agora/);
    assert.equal(db.users.length, 0);
    assert.equal(consoleCalls.length, 0);
  });

  test('/me diz se a idade foi confirmada; conta antiga sai false', async () => {
    db.users.push({ id: 40, username: 'antiga', email: 'a@exemplo.test', adult_confirmed_at: null });
    db.users.push({ id: 41, username: 'nova', email: 'n@exemplo.test', adult_confirmed_at: 'agora' });
    const old = await request('GET', '/api/users/me', { token: jwt.sign({ userId: 40 }, process.env.JWT_SECRET) });
    const fresh = await request('GET', '/api/users/me', { token: jwt.sign({ userId: 41 }, process.env.JWT_SECRET) });
    assert.equal(old.status, 200);
    assert.equal(old.body.user.adult_confirmed, false);
    assert.equal(fresh.body.user.adult_confirmed, true);
    const meQuery = db.queries.find((q) => /FROM users WHERE id = \$1/.test(q.text));
    assert.match(meQuery.text, /to_jsonb\(users\) ->> 'adult_confirmed_at'/);
  });
});
