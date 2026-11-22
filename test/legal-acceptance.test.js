// Aceite dos Termos e da Privacidade com versão e data (decisão de 22/11).
// Banco simulado: nada de banco real nem segredos.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const usersRouter = require('../routes/users');
const {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_VERSION,
  LEGAL_ACCEPTANCE_REQUIRED_MESSAGE,
  LEGAL_REACCEPT_REQUIRED_MESSAGE,
  LEGAL_VERSION_OUTDATED_MESSAGE,
  LEGAL_SAVE_ERROR_MESSAGE
} = require('../lib/legal-acceptance');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

const LEGAL_COLUMNS = ['terms_version', 'terms_accepted_at', 'privacy_version', 'privacy_accepted_at'];
const db = { migrated: true, users: [], queries: [], gone: new Set() };
let hash;

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function missingColumn() {
  const err = new Error('column "terms_version" of relation "users" does not exist');
  err.code = '42703';
  return err;
}

let tick = 0;
function serverNow() {
  tick += 1;
  return new Date(Date.UTC(2026, 10, 22, 18, 0, tick));
}

function legalOf(user) {
  const out = {};
  for (const col of LEGAL_COLUMNS) out[col] = db.migrated ? (user[col] ?? null) : null;
  return out;
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^INSERT INTO users/i.test(text)) {
    if (!db.migrated && /terms_version/.test(text)) throw missingColumn();
    const at = serverNow();
    const user = {
      id: db.users.length + 1,
      username: params[0],
      email: params[1],
      password: params[2],
      adult_confirmed_at: at,
      terms_version: params[3],
      terms_accepted_at: at,
      privacy_version: params[4],
      privacy_accepted_at: at
    };
    db.users.push(user);
    return {
      rows: [{
        id: user.id, username: user.username, email: user.email, bio: null, avatar_url: null,
        created_at: at, updated_at: at, adult_confirmed: true, ...legalOf(user)
      }],
      rowCount: 1
    };
  }

  if (/^UPDATE users SET terms_version = \$2/.test(text)) {
    if (!db.migrated) throw missingColumn();
    const user = db.users.find((u) => u.id === Number(params[0]));
    if (!user) return { rows: [], rowCount: 0 };
    const at = serverNow();
    Object.assign(user, {
      terms_version: params[1], terms_accepted_at: at,
      privacy_version: params[2], privacy_accepted_at: at
    });
    return { rows: [legalOf(user)], rowCount: 1 };
  }

  // Login: lista fechada de campos (sem SELECT *).
  if (/^SELECT id, username, email, password, bio, avatar_url, created_at, updated_at,/.test(text)
    && /FROM users WHERE email = \$1$/.test(text)) {
    assert.doesNotMatch(text, /SELECT \*/);
    const user = db.users.find((u) => u.email === params[0]);
    if (!user) return { rows: [] };
    return {
      rows: [{
        id: user.id, username: user.username, email: user.email, password: user.password,
        bio: null, avatar_url: null, created_at: user.adult_confirmed_at, updated_at: user.adult_confirmed_at,
        adult_confirmed: true, ...legalOf(user)
      }]
    };
  }

  if (/FROM users WHERE id = \$1$/.test(text) && /to_jsonb\(users\) ->> 'terms_version'/.test(text)) {
    const user = db.users.find((u) => u.id === Number(params[0]));
    if (!user) return { rows: [] };
    const legal = legalOf(user);
    return {
      rows: [{
        id: user.id, username: user.username, email: user.email, adult_confirmed: true,
        ...legal,
        terms_accepted_at: legal.terms_accepted_at ? legal.terms_accepted_at.toISOString() : null,
        privacy_accepted_at: legal.privacy_accepted_at ? legal.privacy_accepted_at.toISOString() : null
      }]
    };
  }

  return { rows: [] };
}

function seedUser(id, legal = {}) {
  db.users.push({
    id, username: `conta_${id}`, email: `conta${id}@exemplo.test`, password: hash,
    adult_confirmed_at: new Date(), terms_version: null, terms_accepted_at: null,
    privacy_version: null, privacy_accepted_at: null, ...legal
  });
}

let server;
let baseUrl;
let logged = [];

function tokenFor(id) {
  return jwt.sign({ userId: id }, process.env.JWT_SECRET);
}

async function request(method, url, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : {} };
}

function adultBirth() {
  const d = new Date();
  return `${d.getUTCFullYear() - 30}-01-15`;
}

function register(extra = {}) {
  return request('POST', '/api/users/register', {
    body: {
      username: 'pessoa_teste', email: 'pessoa@exemplo.test', password: 'senha-de-teste',
      birth_date: adultBirth(), ...extra
    }
  });
}

const CURRENT = { terms_version: CURRENT_TERMS_VERSION, privacy_version: CURRENT_PRIVACY_VERSION };

function inserted() {
  return db.queries.some((q) => /^INSERT INTO users/i.test(q.text));
}

function reaccept(id, body = CURRENT, token = tokenFor(id)) {
  return request('POST', '/api/users/me/legal-acceptance', { token, body });
}

describe('aceite dos termos e da privacidade', { concurrency: 1 }, () => {
  before(async () => {
    hash = await bcrypt.hash('senha-de-teste', 4);
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params), {
      missing: (id) => db.gone.has(id) || !db.users.some((u) => u.id === id)
    }));
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      mock.method(console, method, (...args) => { logged.push(args.join(' ')); });
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
    db.migrated = true;
    db.users = [];
    db.queries = [];
    db.gone = new Set();
    logged = [];
  });

  // ---------- cadastro ----------
  test('versão atual é «beta-1» para os dois textos', () => {
    assert.equal(CURRENT_TERMS_VERSION, 'beta-1');
    assert.equal(CURRENT_PRIVACY_VERSION, 'beta-1');
  });

  test('negado: cadastro sem aceite → 400 e nenhum usuário criado', async () => {
    const res = await register();
    assert.equal(res.status, 400);
    assert.equal(res.body.error, LEGAL_ACCEPTANCE_REQUIRED_MESSAGE);
    assert.equal(res.body.code, 'legal_acceptance_required');
    assert.equal(res.body.token, undefined);
    assert.equal(inserted(), false);
    assert.equal(db.users.length, 0);
  });

  test('negado: só um dos dois, vazio ou de outro tipo → 400 e nada criado', async () => {
    const bodies = [
      { terms_version: CURRENT_TERMS_VERSION },
      { privacy_version: CURRENT_PRIVACY_VERSION },
      { terms_version: '', privacy_version: '' },
      { terms_version: '  ', privacy_version: CURRENT_PRIVACY_VERSION },
      { terms_version: true, privacy_version: true },
      { terms_version: ['beta-1'], privacy_version: ['beta-1'] },
      { accepted: true }
    ];
    for (const extra of bodies) {
      const res = await register(extra);
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.equal(res.body.code, 'legal_acceptance_required');
    }
    assert.equal(inserted(), false);
  });

  test('negado: versão antiga (ou de outro texto) → 400 com as versões atuais e nada criado', async () => {
    for (const extra of [
      { terms_version: 'beta-0', privacy_version: CURRENT_PRIVACY_VERSION },
      { terms_version: CURRENT_TERMS_VERSION, privacy_version: 'beta-0' },
      { terms_version: 'BETA-1', privacy_version: 'beta-1' },
      { terms_version: 'beta-1 ', privacy_version: 'beta-1' }
    ]) {
      const res = await register(extra);
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.equal(res.body.error, LEGAL_VERSION_OUTDATED_MESSAGE);
      assert.equal(res.body.code, 'legal_version_outdated');
      assert.equal(res.body.current_terms_version, CURRENT_TERMS_VERSION);
      assert.equal(res.body.current_privacy_version, CURRENT_PRIVACY_VERSION);
    }
    assert.equal(inserted(), false);
  });

  test('com aceite: conta criada com as versões e a hora do servidor', async () => {
    const res = await register(CURRENT);
    assert.equal(res.status, 201);
    const insert = db.queries.find((q) => /^INSERT INTO users/i.test(q.text));
    assert.deepEqual(insert.params.slice(3), [CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION]);
    // A hora vem do banco (NOW()), não do pedido.
    assert.match(insert.text, /\$4, NOW\(\), \$5, NOW\(\)/);
    assert.equal(db.users[0].terms_version, 'beta-1');
    assert.equal(db.users[0].privacy_version, 'beta-1');
    const legal = res.body.user.legal;
    assert.equal(legal.needs_acceptance, false);
    assert.equal(legal.terms_version, 'beta-1');
    assert.ok(Date.parse(legal.terms_accepted_at));
    assert.ok(Date.parse(legal.privacy_accepted_at));
    assert.equal(res.body.user.password, undefined);
    assert.equal(res.body.user.terms_version, undefined, 'só dentro de legal');
  });

  test('a data mandada pelo aparelho não vale', async () => {
    const res = await register({ ...CURRENT, terms_accepted_at: '2000-01-01T00:00:00Z' });
    assert.equal(res.status, 201);
    assert.ok(!JSON.stringify(db.queries.map((q) => q.params)).includes('2000-01-01'));
  });

  test('sem a migração 008: cadastro responde 503 calmo e nenhuma conta é criada', async () => {
    db.migrated = false;
    const res = await register(CURRENT);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'O cadastro não está disponível agora. Tente de novo mais tarde.');
    assert.equal(res.body.token, undefined);
    assert.equal(db.users.length, 0);
  });

  // ---------- como o site sabe ----------
  test('/me: conta sem registro de aceite → needs_acceptance true', async () => {
    seedUser(1);
    const res = await request('GET', '/api/users/me', { token: tokenFor(1) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user.legal, {
      terms_version: null, terms_accepted_at: null,
      privacy_version: null, privacy_accepted_at: null,
      current_terms_version: 'beta-1', current_privacy_version: 'beta-1',
      needs_acceptance: true
    });
  });

  test('/me: aceitou uma versão anterior → needs_acceptance true', async () => {
    const at = new Date('2026-11-01T10:00:00Z');
    seedUser(1, { terms_version: 'beta-0', terms_accepted_at: at, privacy_version: 'beta-1', privacy_accepted_at: at });
    const res = await request('GET', '/api/users/me', { token: tokenFor(1) });
    assert.equal(res.body.user.legal.needs_acceptance, true);
    assert.equal(res.body.user.legal.terms_version, 'beta-0');
  });

  test('login também diz se precisa aceitar de novo', async () => {
    seedUser(1);
    const res = await request('POST', '/api/users/login', {
      body: { email: 'conta1@exemplo.test', password: 'senha-de-teste' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.legal.needs_acceptance, true);
    assert.equal(res.body.user.password, undefined);
  });

  test('negado: o login não devolve colunas cruas (só a lista fechada + legal)', async () => {
    // Colunas que existem no banco e NÃO podem sair no login.
    seedUser(1, {
      terms_version: 'beta-1', terms_accepted_at: new Date(), privacy_version: 'beta-1', privacy_accepted_at: new Date(),
      note_consent: true, reminders_opt_in: true, news_opt_in: false, reminder_time: '08:00', timezone: 'Europe/Lisbon'
    });
    const res = await request('POST', '/api/users/login', {
      body: { email: 'conta1@exemplo.test', password: 'senha-de-teste' }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.user).sort(), [
      'adult_confirmed', 'avatar_url', 'bio', 'created_at', 'email', 'id', 'legal', 'updated_at', 'username'
    ]);
    assert.equal(res.body.user.legal.needs_acceptance, false);
    for (const raw of ['password', 'terms_version', 'note_consent', 'reminders_opt_in', 'adult_confirmed_at', 'reminder_time']) {
      assert.ok(!(raw in res.body.user), raw);
    }
    assert.ok(!JSON.stringify(res.body).includes(hash), 'o hash da senha não sai');
    const query = db.queries.find((q) => /FROM users WHERE email/.test(q.text));
    assert.doesNotMatch(query.text, /SELECT \*/);
  });

  test('negado: login com senha errada ou e-mail que não existe → 401', async () => {
    seedUser(1);
    const wrong = await request('POST', '/api/users/login', { body: { email: 'conta1@exemplo.test', password: 'errada' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.user, undefined);
    const none = await request('POST', '/api/users/login', { body: { email: 'ninguem@exemplo.test', password: 'senha-de-teste' } });
    assert.equal(none.status, 401);
  });

  test('sem a migração 008: /me e login funcionam e pedem o aceite', async () => {
    seedUser(1);
    db.migrated = false;
    const me = await request('GET', '/api/users/me', { token: tokenFor(1) });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.legal.needs_acceptance, true);
    const login = await request('POST', '/api/users/login', {
      body: { email: 'conta1@exemplo.test', password: 'senha-de-teste' }
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.legal.needs_acceptance, true);
  });

  // ---------- reaceitar ----------
  test('reaceitar grava as versões atuais e a hora; o /me deixa de pedir', async () => {
    seedUser(1, { terms_version: 'beta-0', terms_accepted_at: new Date(), privacy_version: 'beta-0', privacy_accepted_at: new Date() });
    const res = await reaccept(1);
    assert.equal(res.status, 200);
    assert.equal(res.body.legal.needs_acceptance, false);
    assert.equal(res.body.legal.terms_version, 'beta-1');
    assert.ok(Date.parse(res.body.legal.privacy_accepted_at));
    const me = await request('GET', '/api/users/me', { token: tokenFor(1) });
    assert.equal(me.body.user.legal.needs_acceptance, false);
  });

  test('negado: reaceitar sem login → 401 e nada muda', async () => {
    seedUser(1);
    const res = await reaccept(1, CURRENT, null);
    assert.equal(res.status, 401);
    assert.equal(db.users[0].terms_version, null);
    assert.ok(!db.queries.some((q) => /^UPDATE users/.test(q.text)));
  });

  test('negado: conta excluída (token antigo) → 401 e nada muda', async () => {
    seedUser(1);
    db.gone.add(1);
    const res = await reaccept(1);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'session_ended');
    assert.equal(db.users[0].terms_version, null);
  });

  test('negado: reaceitar sem aceite ou com versão antiga → 400 e nada muda', async () => {
    seedUser(1);
    const empty = await reaccept(1, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, LEGAL_REACCEPT_REQUIRED_MESSAGE);
    const old = await reaccept(1, { terms_version: 'beta-0', privacy_version: 'beta-0' });
    assert.equal(old.status, 400);
    assert.equal(old.body.code, 'legal_version_outdated');
    assert.equal(db.users[0].terms_version, null);
    assert.ok(!db.queries.some((q) => /^UPDATE users/.test(q.text)));
  });

  test('outra pessoa não reaceita por você (nem com user_id no corpo)', async () => {
    seedUser(1);
    seedUser(2);
    const res = await reaccept(2, { ...CURRENT, user_id: 1, id: 1 });
    assert.equal(res.status, 200);
    assert.equal(db.users[0].terms_version, null, 'a conta 1 continua sem aceite');
    assert.equal(db.users[1].terms_version, 'beta-1');
    const updates = db.queries.filter((q) => /^UPDATE users/.test(q.text));
    assert.ok(updates.length === 1 && Number(updates[0].params[0]) === 2);
    const me = await request('GET', '/api/users/me', { token: tokenFor(1) });
    assert.equal(me.body.user.legal.needs_acceptance, true);
  });

  test('sem a migração 008: reaceitar responde 503 calmo, sem log', async () => {
    seedUser(1);
    db.migrated = false;
    const res = await reaccept(1);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, LEGAL_SAVE_ERROR_MESSAGE);
    assert.equal(res.body.code, 'legal_unavailable');
    assert.deepEqual(logged, []);
  });
});

// ---------- migração ----------
test('008: só acrescenta, sem default de aceite, registra a versão e explica a volta', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '008_user_legal_acceptance.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(code, /DEFAULT/i);
  for (const col of ['terms_version VARCHAR(40)', 'terms_accepted_at TIMESTAMPTZ',
    'privacy_version VARCHAR(40)', 'privacy_accepted_at TIMESTAMPTZ']) {
    assert.ok(code.includes(`ADD COLUMN IF NOT EXISTS ${col}`), col);
  }
  assert.match(code, /CHECK \(\(terms_version IS NULL\) = \(terms_accepted_at IS NULL\)\)/);
  assert.match(code, /CHECK \(\(privacy_version IS NULL\) = \(privacy_accepted_at IS NULL\)\)/);
  assert.match(code, /'008_user_legal_acceptance'/);
  assert.match(code, /^BEGIN;/m);
  assert.match(code, /^COMMIT;/m);
  assert.match(sql, /Para voltar atrás/);
});
