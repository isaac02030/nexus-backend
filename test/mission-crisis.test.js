// Filtro de crise em todo texto livre do contrato e da missão, ao criar
// (decisão de 27/11). Com alerta em qualquer campo: nada gravado, crisis +
// crisis_level, a mesma frase, e o texto não vai para o banco nem para log.
// Banco simulado.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const missionsRouter = require('../routes/missions');
const { MISSION_TEXT_FIELDS, MISSION_LEVELS, PROOF_MODES } = missionsRouter;

const MESSAGE = 'A missão não foi criada. Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const ALTO = 'quero me matar';
const MEDIO = 'sinto que sou um peso';

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

const state = { queries: [], inserts: [] };
function handle(sql, params = []) {
  const text = normalize(sql);
  state.queries.push({ text, params });
  if (/^INSERT INTO missions/i.test(text)) {
    state.inserts.push({ text, params });
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
const logs = [];

async function create(body, { token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET) } = {}) {
  const r = await fetch(`${baseUrl}/api/missions`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  return { status: r.status, body: raw ? JSON.parse(raw) : {} };
}

const BASE = {
  title: 'Ler uma página', category: 'aprendizagem', description: 'Ler todo dia', daily_minimum: 'Uma página',
  commitment_window: 'Antes de dormir', why_it_matters: 'Quero ler mais', fallback_plan: 'Leio meia página',
  study_focus: 'Romances', study_current_stage: 'Começando', study_target_outcome: 'Um livro por mês',
  area: 'mente', subject: 'leitura'
};
const reached = (fragment) => state.queries.some((q) => q.params.some((p) => typeof p === 'string' && p.includes(fragment)));

describe('filtro de crise no contrato e na missão', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({ query: async (sql, params) => handle(sql, params), release() {} }));
    for (const name of ['log', 'error', 'warn', 'info']) mock.method(console, name, (...args) => { logs.push(args); });
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    state.queries = [];
    state.inserts = [];
    logs.length = 0;
  });

  test('os campos pedidos estão na lista (e o assunto, do PR 45)', () => {
    for (const f of ['title', 'daily_minimum', 'why_it_matters', 'fallback_plan', 'description', 'study_focus', 'subject']) {
      assert.ok(MISSION_TEXT_FIELDS.includes(f), f);
    }
  });

  for (const field of ['title', 'category', 'description', 'daily_minimum', 'commitment_window', 'why_it_matters',
    'fallback_plan', 'study_focus', 'study_current_stage', 'study_target_outcome', 'subject']) {
    test(`negado: crise em ${field} (alto e médio): nada gravado, texto fora do banco e do log`, async () => {
      for (const [text, level] of [[ALTO, 'alto'], [MEDIO, 'medio']]) {
        state.queries = [];
        const res = await create({ ...BASE, [field]: `hoje ${text}` });
        assert.equal(res.status, 200, `${field} ${level}`);
        assert.deepEqual(res.body, { saved: false, crisis: true, crisis_level: level, message: MESSAGE });
        assert.equal(state.inserts.length, 0, field);
        assert.equal(reached('matar') || reached('peso'), false, field);
      }
      assert.equal(logs.length, 0, field);
    });
  }

  test('vários campos com alerta: vale o nível mais alto', async () => {
    const res = await create({ ...BASE, daily_minimum: MEDIO, fallback_plan: ALTO });
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(state.inserts.length, 0);
  });

  test('a crise vem antes da validação (sem título também mostra a ajuda)', async () => {
    const res = await create({ category: 'x', why_it_matters: ALTO });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
  });

  test('negado: nível fora da lista: 400, nada gravado', async () => {
    for (const level of ['mestre', 'Iniciante', '', 3, 'quero desistir', { a: 1 }]) {
      const res = await create({ ...BASE, level });
      assert.equal(res.status, 400, JSON.stringify(level));
      assert.equal(res.body.code, 'invalid_level');
      assert.equal(res.body.error, 'Escolha um nível da lista.');
    }
    assert.equal(state.inserts.length, 0);
  });

  test('negado: modo de prova fora da lista: 400, nada gravado', async () => {
    for (const proof of ['foto', 'SELF_REPORT', '', 1, ['study_note']]) {
      const res = await create({ ...BASE, proof_mode: proof });
      assert.equal(res.status, 400, JSON.stringify(proof));
      assert.equal(res.body.code, 'invalid_proof_mode');
      assert.equal(res.body.error, 'Escolha um modo de prova da lista.');
    }
    assert.equal(state.inserts.length, 0);
  });

  test('os valores que o site novo e o app antigo mandam passam', async () => {
    for (const level of MISSION_LEVELS) {
      state.inserts = [];
      assert.equal((await create({ ...BASE, level })).status, 201, level);
    }
    for (const proof of PROOF_MODES) {
      state.inserts = [];
      assert.equal((await create({ ...BASE, proof_mode: proof })).status, 201, proof);
    }
    // nexus-v2 (onboarding.js) manda study_note ou workout_proof, sem nível.
    assert.ok(PROOF_MODES.includes('study_note') && PROOF_MODES.includes('workout_proof'));
  });

  test('negado: texto de crise no nível: recusado pela lista fechada, nada gravado nem enviado ao banco', async () => {
    // level e proof_mode não passam pelo filtro: são lista fechada, e um
    // texto qualquer ali nunca é gravado.
    const res = await create({ ...BASE, level: ALTO });
    assert.equal(res.status, 400);
    assert.equal(state.inserts.length, 0);
    assert.equal(reached('matar'), false);
  });

  test('contrato comum cria; campos que não são texto não quebram o filtro', async () => {
    const res = await create({ ...BASE, mission_weekdays: [1, 2, 3] });
    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, undefined);
    assert.equal(state.inserts.length, 1);
  });

  test('negado: sem login, 401 antes de tudo', async () => {
    const res = await create({ ...BASE, title: ALTO }, { token: null });
    assert.equal(res.status, 401);
    assert.equal(state.inserts.length, 0);
  });

  test('guarda: toda coluna de texto do INSERT passa pelo filtro', async () => {
    await create(BASE);
    const text = state.inserts[0].text;
    const columns = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').map((c) => c.trim());
    // Isentas só as colunas que NÃO recebem texto livre: o id de quem cria,
    // o modo (literal 'solo' no SQL) e as de lista fechada validada antes do
    // INSERT (preferência de par, nível, prova, dias e área). Cada lista
    // fechada tem teste de recusa (400).
    const notFreeText = ['user_id', 'mode', 'match_preference', 'level', 'proof_mode', 'mission_weekdays', 'area'];
    assert.match(text, /VALUES \(\$1, \$2, \$3, \$4, 'solo',/, 'o modo é literal');
    for (const c of columns) {
      if (notFreeText.includes(c)) continue;
      assert.ok(MISSION_TEXT_FIELDS.includes(c), `${c} não passa pelo filtro de crise`);
    }
  });
});
