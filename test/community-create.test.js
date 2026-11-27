// Criar comunidade (PR B): 1 missão de 30 dias concluída, área obrigatória,
// filtro de crise no nome, no assunto e nas regras, limite contra spam.
// E a migração 014 (as 8 comunidades prontas). Banco simulado.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const communitiesRouter = require('../routes/communities');

const app = express();
app.use(express.json());
app.use('/api/communities', communitiesRouter);

const db = {};

function resetDb() {
  db.completed = new Map();   // userId -> missões de 30+ dias concluídas
  db.recent = new Map();      // userId -> comunidades criadas nos últimos 7 dias
  db.slugs = new Set(['estudos', 'leitura']);
  db.created = [];
  db.queries = [];
  db.notAdult = new Set();
  db.before013 = false;
  db.failInsert = false;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
  if (/adult_confirmed_at'\) IS NOT NULL AS adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !db.notAdult.has(Number(params[0])) }] };
  }
  if (/^SELECT COUNT\(\*\) AS total FROM missions WHERE \(user_id = \$1 OR partner_id = \$1\) AND status = 'completed' AND duration_days >= \$2$/i.test(text)) {
    return { rows: [{ total: String(db.completed.get(Number(params[0])) || 0) }] };
  }
  if (/FROM users WHERE id = \$1 FOR UPDATE/i.test(text)) return { rows: [{ id: Number(params[0]) }] };
  if (/^SELECT COUNT\(\*\) AS total FROM communities WHERE created_by = \$1 AND created_at > NOW\(\) - INTERVAL '7 days'$/i.test(text)) {
    return { rows: [{ total: String(db.recent.get(Number(params[0])) || 0) }] };
  }
  if (/^INSERT INTO communities/i.test(text)) {
    if (db.before013) throw Object.assign(new Error('column "area" does not exist'), { code: '42703' });
    if (db.failInsert) throw new Error('falha simulada');
    if (db.slugs.has(params[1])) throw Object.assign(new Error('duplicado'), { code: '23505' });
    db.slugs.add(params[1]);
    const row = { id: 100 + db.created.length, name: params[0], slug: params[1], description: params[2], category: params[3], area: params[4], created_by: params[7] };
    db.created.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }
  return { rows: [] };
}

const tokenFor = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
let server;
let baseUrl;
const consoleCalls = [];

async function create(body, { token = tokenFor(1) } = {}) {
  const response = await fetch(`${baseUrl}/api/communities`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : {} };
}

const OK = { name: 'Filosofia Antiga', area: 'mente', category: 'filosofia', description: 'Uma leitura por dia, sem pressa.' };
const inserted = () => db.queries.some((q) => /^INSERT INTO communities/i.test(q.text));
const reachedDb = (fragment) => db.queries.some((q) => q.params.some((p) => typeof p === 'string' && p.includes(fragment)));

describe('criar comunidade', { concurrency: 1 }, () => {
  before(async () => {
    resetDb();
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({ query: async (sql, params) => handle(sql, params), release() {} }));
    for (const name of ['log', 'error', 'warn', 'info']) {
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
    consoleCalls.length = 0;
    db.completed.set(1, 1);
  });

  test('com 1 missão de 30 dias concluída: cria, com área, assunto e autor', async () => {
    const res = await create(OK);
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Comunidade criada.');
    const c = db.created[0];
    assert.deepEqual([c.name, c.slug, c.category, c.area, c.created_by], ['Filosofia Antiga', 'filosofia-antiga', 'filosofia', 'mente', 1]);
  });

  test('sem assunto: a categoria fica com a área', async () => {
    const res = await create({ name: 'Meditação', area: 'rotina' });
    assert.equal(res.status, 201);
    assert.equal(db.created[0].category, 'rotina');
    assert.equal(db.created[0].slug, 'meditacao');
    assert.equal(db.created[0].description, null);
  });

  test('negado: sem missão de 30 dias concluída: 403 com o motivo, nada criado', async () => {
    db.completed.set(1, 0);
    const res = await create(OK);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'needs_completed_mission');
    assert.equal(res.body.error, 'Criar uma comunidade abre depois que você concluir uma missão de 30 dias.');
    assert.equal(res.body.locked, true);
    assert.equal(inserted(), false);
    const q = db.queries.find((item) => /FROM missions/.test(item.text));
    assert.match(q.text, /status = 'completed' AND duration_days >= \$2$/);
    assert.deepEqual(q.params, [1, 30]);
  });

  test('negado: área faltando ou inválida: 400, nem pergunta ao banco das missões', async () => {
    for (const area of [undefined, '', 'Mente', 'saude', 3, ['mente']]) {
      const res = await create({ ...OK, area });
      assert.equal(res.status, 400, JSON.stringify(area));
      assert.equal(res.body.code, 'invalid_area');
      assert.equal(res.body.error, 'Escolha uma área: Mente, Corpo ou Rotina.');
    }
    assert.equal(db.queries.some((q) => /FROM missions/.test(q.text)), false);
    assert.equal(inserted(), false);
  });

  test('negado: crise no nome, no assunto ou nas regras: crisis true, nada criado nem enviado ao banco', async () => {
    for (const field of ['name', 'category', 'description']) {
      resetDb();
      db.completed.set(1, 1);
      const res = await create({ ...OK, [field]: 'quero me matar' });
      assert.equal(res.status, 200, field);
      assert.equal(res.body.crisis, true, field);
      assert.equal(res.body.saved, false, field);
      assert.ok(['alto', 'medio'].includes(res.body.crisis_level), field);
      assert.equal(inserted(), false, field);
      assert.equal(reachedDb('matar'), false, field);
    }
    assert.equal(consoleCalls.length, 0);
  });

  test('negado: sem 18+ e nome com crise: a ajuda vem antes do 403, nada criado', async () => {
    db.notAdult.add(1);
    const res = await create({ ...OK, name: 'quero me matar' });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(inserted(), false);
  });

  test('negado: sem 18+: 403 com código; sem login: 401', async () => {
    db.notAdult.add(1);
    const adult = await create(OK);
    assert.equal(adult.status, 403);
    assert.equal(adult.body.code, 'adult_confirmation_required');
    const noLogin = await create(OK, { token: null });
    assert.equal(noLogin.status, 401);
    assert.equal(inserted(), false);
  });

  test('negado: limite de 1 por semana: 429, ROLLBACK, nada criado; a trava vem antes da contagem', async () => {
    db.recent.set(1, 1);
    const res = await create(OK);
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'Você já criou uma comunidade nesta semana. Tente de novo daqui a alguns dias.');
    assert.equal(inserted(), false);
    const texts = db.queries.map((q) => q.text);
    assert.ok(texts.includes('ROLLBACK'));
    assert.ok(texts.findIndex((t) => /FOR UPDATE/.test(t)) < texts.findIndex((t) => /FROM communities WHERE created_by/.test(t)));
  });

  test('negado: nome que já existe ou reservado: 409 «Já existe uma comunidade com esse nome.»', async () => {
    const taken = await create({ ...OK, name: 'Leitura' });
    const reserved = await create({ ...OK, name: 'Recommended' });
    for (const res of [taken, reserved]) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'Já existe uma comunidade com esse nome.');
    }
    assert.equal(db.created.length, 0);
  });

  test('negado: tamanhos e tipos', async () => {
    const cases = [
      [{ ...OK, name: 'a'.repeat(41) }, 'invalid_name'],
      [{ ...OK, name: '   ' }, 'invalid_name'],
      [{ ...OK, name: '!!!' }, 'invalid_name'],
      [{ ...OK, name: { a: 1 } }, 'invalid_text'],
      [{ ...OK, category: 'a'.repeat(31) }, 'invalid_topic'],
      [{ ...OK, description: 'a'.repeat(201) }, 'invalid_description']
    ];
    for (const [body, code] of cases) {
      const res = await create(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(res.body.code, code);
    }
    assert.equal(inserted(), false);
    const fine = await create({ ...OK, name: 'é'.repeat(40) });
    assert.equal(fine.status, 201);
  });

  test('negado: antes da 013: 503 calmo, com ROLLBACK', async () => {
    db.before013 = true;
    const res = await create(OK);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'Criar uma comunidade ainda não está disponível. Tente de novo mais tarde.');
    assert.ok(db.queries.some((q) => q.text === 'ROLLBACK'));
    assert.equal(db.created.length, 0);
  });

  test('erro do banco: 500 calmo, sem log', async () => {
    db.failInsert = true;
    const res = await create(OK);
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Tente de novo/);
    assert.equal(consoleCalls.length, 0);
  });
});

describe('migração 014: as 8 comunidades prontas', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '014_default_communities.sql'), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');
  const rows = [...code.matchAll(/\('([^']+)', '([a-z]+)', '([^']+)', '([a-z]+)', '(mente|corpo|rotina)', true, NULL, 0\)/g)]
    .map(([, name, slug, description, category, area]) => ({ name, slug, description, category, area }));

  test('8 linhas, slug fixo, na área decidida', () => {
    assert.deepEqual(rows.map((r) => [r.slug, r.area]), [
      ['estudos', 'mente'], ['idiomas', 'mente'], ['leitura', 'mente'],
      ['academia', 'corpo'], ['corrida', 'corpo'], ['alimentacao', 'corpo'],
      ['organizacao', 'rotina'], ['sono', 'rotina']
    ]);
    assert.deepEqual(rows.map((r) => r.name), ['Estudos', 'Idiomas', 'Leitura', 'Academia', 'Corrida', 'Alimentação', 'Organização', 'Sono']);
  });

  test('idempotente e sem tocar em linha existente: ON CONFLICT DO NOTHING, sem UPDATE/DELETE/DROP', () => {
    assert.match(code, /ON CONFLICT \(slug\) DO NOTHING;/);
    assert.doesNotMatch(code, /\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
    assert.match(code, /'014_default_communities'/);
    assert.match(code, /^\s*BEGIN;/m);
    assert.match(code, /COMMIT;\s*$/);
  });

  test('Alimentação: dicas sim, promessa de emagrecer e números extremos não', () => {
    const food = rows.find((r) => r.slug === 'alimentacao');
    assert.match(food.description, /Aqui valem dicas; promessa de emagrecer e números extremos não\./);
  });

  test('descrições curtas, sem emoji nem exclamação; bloco de voltar atrás no cabeçalho', () => {
    for (const r of rows) {
      assert.ok(Array.from(r.description).length <= 200, r.slug);
      assert.doesNotMatch(r.description, /[!\u{1F300}-\u{1FAFF}]/u, r.slug);
    }
    assert.match(sql, /-- Para voltar atrás/);
    assert.match(sql, /--\s+DELETE FROM communities\n--\s+WHERE is_default = true AND created_by IS NULL/);
  });
});
