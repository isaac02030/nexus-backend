// Áreas da comunidade (migração 013): a regra num lugar só
// (lib/community-access.js) e a criação da missão com área e assunto.
// Banco simulado, sem Postgres.
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

const access = require('../lib/community-access');
const missionsRouter = require('../routes/missions');

// ---------- Regra pura ----------

describe('áreas: regra de postar e busca por palavra', () => {
  test('só 3 áreas, exatamente', () => {
    assert.deepEqual(access.AREAS, ['mente', 'corpo', 'rotina']);
    for (const bad of ['Mente', ' mente', 'saude', '', 1, null, undefined, ['mente'], {}]) {
      assert.equal(access.isValidArea(bad), false, String(bad));
    }
  });

  test('postar: mesma área passa; sem missão, outra área, sem área e comunidade sem área não', () => {
    assert.equal(access.postAccess(['mente'], 'mente').ok, true);
    assert.equal(access.postAccess(['corpo', 'mente'], 'mente').ok, true);
    assert.equal(access.postAccess([], 'mente').code, 'no_active_mission');
    assert.equal(access.postAccess(undefined, 'mente').code, 'no_active_mission');
    assert.equal(access.postAccess(['corpo'], 'mente').code, 'other_area');
    assert.equal(access.postAccess([null], 'rotina').code, 'mission_without_area');
    assert.equal(access.postAccess(['mente'], null).code, 'community_without_area');
    assert.equal(access.postAccess(['mente'], 'qualquer').code, 'community_without_area');
  });

  test('textos do motivo (para o sim do dono do projeto)', () => {
    assert.equal(access.postAccess([], 'corpo').message, 'Para postar aqui você precisa de uma missão ativa em Corpo.');
    assert.equal(access.postAccess(['rotina'], 'mente').message, 'Sua missão ativa é de Rotina. Esta comunidade é de Mente.');
    assert.equal(access.postAccess([null], 'mente').message, 'Sua missão ativa ainda não tem área. Para postar aqui, ela precisa ser de Mente.');
    assert.equal(access.postAccess([], null).message, 'Esta comunidade ainda não está aberta para posts.');
  });

  test('palavras: sem acento, minúsculas, 3+ letras, sem repetir nem palavras vazias', () => {
    assert.deepEqual(access.words('Psicológia, É para a VIDA e para mim!'), ['psicologia', 'vida', 'mim']);
    assert.deepEqual(access.words(null), []);
  });

  test('assunto: palavra igual ou começo de palavra com 4+ letras', () => {
    assert.equal(access.subjectScore('idioma', { name: 'Idiomas' }), 1);
    assert.equal(access.subjectScore('corrida longa', { name: 'Corrida', description: 'Treinos longos' }), 1);
    assert.equal(access.subjectScore('sol', { name: 'Solidão' }), 0);
    assert.equal(access.subjectScore('', { name: 'Leitura' }), 0);
  });

  test('ordem: assunto primeiro, depois as prontas, mais gente e o id', () => {
    const list = [
      { id: 9, name: 'Leitura', is_default: true, member_count: 50 },
      { id: 2, name: 'Filosofia', member_count: 1 },
      { id: 3, name: 'Estudos', is_default: true, member_count: 50 },
      { id: 1, name: 'Outra', member_count: 80 }
    ];
    const ranked = access.rankBySubject('filosofia antiga', list);
    assert.deepEqual(ranked.map((c) => c.id), [2, 3, 9, 1]);
    assert.deepEqual(ranked.map((c) => c.subject_match), [true, false, false, false]);
    assert.deepEqual(access.rankBySubject(null, list).map((c) => c.id), [3, 9, 1, 2]);
  });

  test('assunto: opcional, até 60 caracteres reais, espaços juntados', () => {
    assert.deepEqual(access.parseSubject(undefined), { ok: true, value: null });
    assert.deepEqual(access.parseSubject('   '), { ok: true, value: null });
    assert.deepEqual(access.parseSubject('  filosofia   antiga '), { ok: true, value: 'filosofia antiga' });
    assert.equal(access.parseSubject('é'.repeat(60)).ok, true);
    assert.equal(access.parseSubject('a'.repeat(61)).ok, false);
    assert.equal(access.parseSubject(12).ok, false);
  });
});

// ---------- Migração 013 ----------

describe('migração 013', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '013_community_areas.sql'), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');

  test('só acrescenta: sem DROP, UPDATE ou DELETE fora do bloco de voltar atrás', () => {
    assert.doesNotMatch(code, /\b(DROP|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.match(code, /ADD COLUMN IF NOT EXISTS area VARCHAR\(10\)/);
    assert.match(code, /ADD COLUMN IF NOT EXISTS subject VARCHAR\(60\)/);
  });

  test('CHECK nos 3 valores, nas missões e nas comunidades', () => {
    const checks = code.match(/CHECK \(area IN \('mente', 'corpo', 'rotina'\)\)/g) || [];
    assert.equal(checks.length, 2);
  });

  test('nenhuma coluna nova aponta para users (a lista da exclusão não muda por isso)', () => {
    assert.doesNotMatch(code, /REFERENCES users/);
  });

  test('registra a versão e fica numa transação', () => {
    assert.match(code, /^\s*BEGIN;/m);
    assert.match(code, /'013_community_areas'/);
    assert.match(code, /COMMIT;\s*$/);
  });
});

// ---------- Criar missão com área e assunto ----------

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

const state = { inserts: [], failInsertWith: null, failMessage: '' };

function handle(sql, params = []) {
  const text = normalize(sql);
  if (/^INSERT INTO missions/i.test(text)) {
    state.inserts.push({ text, params });
    if (state.failInsertWith) {
      throw Object.assign(new Error(state.failMessage || 'coluna não existe'), { code: state.failInsertWith });
    }
    return { rows: [{ id: 70, user_id: params[0], title: params[1], status: 'waiting' }] };
  }
  if (/^UPDATE missions SET status = 'active'/i.test(text)) {
    return { rows: [{ id: 70, user_id: 1, status: 'active', started_at: params[0], ends_at: params[1] }] };
  }
  return { rows: [] };
}

const app = express();
app.use(express.json());
app.use('/api/missions', missionsRouter);

let server;
let baseUrl;

async function create(body, { token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET) } = {}) {
  const response = await fetch(`${baseUrl}/api/missions`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : {} };
}

const BASE = { title: 'Ler uma página', category: 'leitura' };

describe('criar missão com área e assunto', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({ query: async (sql, params) => handle(sql, params), release() {} }));
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    state.inserts = [];
    state.failInsertWith = null;
    state.failMessage = '';
  });

  test('com área e assunto: entram no INSERT, nos parâmetros certos', async () => {
    const res = await create({ ...BASE, area: 'mente', subject: '  psicologia  ' });
    assert.equal(res.status, 201);
    const { text, params } = state.inserts[0];
    assert.match(text, /study_target_outcome, area, subject \)/);
    assert.match(text, /\$14, \$15, \$16\)/);
    assert.equal(params[14], 'mente');
    assert.equal(params[15], 'psicologia');
  });

  test('com dias, área e assunto: a numeração dos parâmetros segue a ordem', async () => {
    const res = await create({ ...BASE, area: 'corpo', subject: 'corrida', mission_weekdays: [1, 3, 5] });
    assert.equal(res.status, 201);
    const { text, params } = state.inserts[0];
    assert.match(text, /mission_weekdays, area, subject \)/);
    assert.match(text, /\$15::smallint\[\], \$16, \$17\)/);
    assert.deepEqual(params.slice(14), [[1, 3, 5], 'corpo', 'corrida']);
  });

  test('sem área: o INSERT fica igual ao de antes (funciona sem a 013)', async () => {
    const res = await create(BASE);
    assert.equal(res.status, 201);
    assert.doesNotMatch(state.inserts[0].text, /\barea\b|\bsubject\b/);
    assert.equal(state.inserts[0].params.length, 14);
  });

  test('negado: área inválida: 400 com o texto, nada criado', async () => {
    for (const area of ['saude', 'Mente', '', 7, ['mente'], { a: 1 }]) {
      const res = await create({ ...BASE, area });
      assert.equal(res.status, 400, JSON.stringify(area));
      assert.equal(res.body.code, 'invalid_area');
      assert.equal(res.body.error, 'Escolha uma área: Mente, Corpo ou Rotina.');
    }
    assert.equal(state.inserts.length, 0);
  });

  test('negado: assunto longo demais ou não texto: 400, nada criado', async () => {
    const long = await create({ ...BASE, area: 'mente', subject: 'a'.repeat(61) });
    const notText = await create({ ...BASE, area: 'mente', subject: { a: 1 } });
    assert.equal(long.status, 400);
    assert.match(long.body.error, /60 caracteres/);
    assert.equal(notText.status, 400);
    assert.equal(notText.body.code, 'invalid_subject');
    assert.equal(state.inserts.length, 0);
  });

  test('negado: antes da 013, criar com área dá 503 calmo, nada criado', async () => {
    state.failInsertWith = '42703';
    state.failMessage = 'column "area" of relation "missions" does not exist';
    const res = await create({ ...BASE, area: 'rotina', mission_weekdays: [1, 2, 3] });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'area_unavailable');
    assert.match(res.body.error, /Crie a missão sem escolher a área/);
  });

  test('antes da 004 (dias) com área já aplicada: a mensagem continua a dos dias', async () => {
    state.failInsertWith = '42703';
    state.failMessage = 'column "mission_weekdays" of relation "missions" does not exist';
    const res = await create({ ...BASE, area: 'rotina', mission_weekdays: [1, 2, 3] });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /escolha dos dias/);
  });

  test('negado: sem login: 401, nada criado', async () => {
    const res = await create({ ...BASE, area: 'mente' }, { token: null });
    assert.equal(res.status, 401);
    assert.equal(state.inserts.length, 0);
  });
});
