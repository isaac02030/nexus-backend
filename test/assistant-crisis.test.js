// Filtro de crise antes da IA e erro do provedor sem eco (decisão de 22/11).
// Banco simulado; a chamada à OpenAI é interceptada (nada sai da máquina).
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';
process.env.MATCHING_ENABLED = 'false';

const assistantRouter = require('../routes/assistant');

const app = express();
app.use(express.json());
app.use('/api/assistant', assistantRouter);

const PROVIDER_SECRET_TEXT = 'mensagem-interna-do-provedor-999';

const state = { mission: null, dbFails: false };
const sent = [];
const logged = [];
let providerReply = null;

function baseMission(overrides = {}) {
  return {
    id: 10,
    user_id: 1,
    partner_id: null,
    status: 'active',
    mode: 'solo',
    category: 'habito',
    level: 'base',
    proof_mode: 'self_report',
    title: 'caminhar',
    daily_minimum: '10 minutos',
    commitment_window: 'manha',
    why_it_matters: 'ter mais energia',
    fallback_plan: 'caminhar 5 minutos',
    study_focus: null,
    study_current_stage: null,
    study_target_outcome: null,
    ...overrides
  };
}

function handleQuery(sql, params = []) {
  if (state.dbFails) {
    const err = new Error('relation "missions" does not exist, valor quero me matar');
    err.code = '42P01';
    throw err;
  }
  const text = String(sql);
  if (/FROM missions/i.test(text)) {
    const m = state.mission;
    if (!m || Number(m.id) !== Number(params[0])) return { rows: [] };
    if (Number(m.user_id) !== Number(params[1]) && Number(m.partner_id) !== Number(params[1])) return { rows: [] };
    return { rows: [{ ...m }] };
  }
  return { rows: [] };
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

let server;
let baseUrl;
const originalKey = process.env.OPENAI_API_KEY;

async function ask(question, { token = tokenFor(1), missionId = 10 } = {}) {
  const response = await fetch(`${baseUrl}/api/assistant/mission`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mission_id: missionId, question })
  });
  const raw = await response.text();
  return { status: response.status, raw, body: raw ? JSON.parse(raw) : {} };
}

function loggedText() {
  return logged.map(args => args.map(String).join(' ')).join('\n');
}

describe('assistente: filtro de crise e erro sem eco', { concurrency: 1 }, () => {
  before(async () => {
    process.env.OPENAI_API_KEY = 'chave-falsa-de-teste';
    mock.method(Pool.prototype, 'query', (sql, params) => handleQuery(sql, params));
    mock.method(console, 'error', (...args) => { logged.push(args); });
    mock.method(console, 'log', (...args) => { logged.push(args); });
    // Intercepta a OpenAI: guarda o corpo e responde conforme providerReply.
    mock.method(https, 'request', (options, onResponse) => {
      const req = new EventEmitter();
      let body = '';
      req.setTimeout = () => req;
      req.write = (chunk) => { body += chunk; };
      req.destroy = (err) => { if (err) req.emit('error', err); };
      req.end = () => {
        sent.push({ host: options.hostname, body });
        const reply = providerReply;
        if (reply.network) {
          const err = new Error(PROVIDER_SECRET_TEXT);
          err.code = 'ECONNRESET';
          process.nextTick(() => req.emit('error', err));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = reply.status;
        onResponse(res);
        res.emit('data', reply.raw);
        res.emit('end');
      };
      return req;
    });
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    state.mission = baseMission();
    state.dbFails = false;
    sent.length = 0;
    logged.length = 0;
    providerReply = { status: 200, raw: JSON.stringify({ output_text: 'resposta de teste' }) };
  });

  after(async () => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('pergunta normal: a chamada à OpenAI acontece', async () => {
    const res = await ask('o que faco hoje?');
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'openai');
    assert.equal(res.body.answer, 'resposta de teste');
    assert.equal(res.body.crisis, undefined);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].host, 'api.openai.com');
  });

  test('pergunta de crise (alto): nada vai à OpenAI, crisis true, nada no log', async () => {
    const res = await ask('hoje eu quero me matar');
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(res.body.source, 'crisis');
    assert.equal(sent.length, 0);
    assert.equal(res.raw.includes('matar'), false);
    assert.equal(loggedText().includes('matar'), false);
  });

  test('pergunta de crise (médio): crisis_level medio e nada vai à OpenAI', async () => {
    const res = await ask('nao vejo saida');
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'medio');
    assert.equal(sent.length, 0);
  });

  for (const field of [
    'title', 'daily_minimum', 'commitment_window', 'why_it_matters',
    'fallback_plan', 'study_focus', 'study_current_stage', 'study_target_outcome'
  ]) {
    test(`campo de crise na missão (${field}): nada vai à OpenAI`, async () => {
      state.mission = baseMission({ [field]: 'quero me matar' });
      const res = await ask('o que faco hoje?');
      assert.equal(res.status, 200);
      assert.equal(res.body.crisis, true);
      assert.equal(res.body.crisis_level, 'alto');
      assert.equal(sent.length, 0);
      assert.equal(res.raw.includes('matar'), false);
      assert.equal(loggedText().includes('matar'), false);
    });
  }

  test('sem chave da OpenAI, a crise também responde crisis (sem resposta de treino)', async () => {
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await ask('quero me matar');
      assert.equal(res.body.crisis, true);
      assert.equal(res.body.source, 'crisis');
      assert.equal(sent.length, 0);
    } finally {
      process.env.OPENAI_API_KEY = 'chave-falsa-de-teste';
    }
  });

  test('quem não participa recebe 404 e nada vai à OpenAI', async () => {
    const res = await ask('o que faco hoje?', { token: tokenFor(8) });
    assert.equal(res.status, 404);
    assert.equal(sent.length, 0);
  });

  test('sem login: 401', async () => {
    const response = await fetch(`${baseUrl}/api/assistant/mission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission_id: 10, question: 'oi' })
    });
    assert.equal(response.status, 401);
    assert.equal(sent.length, 0);
  });

  test('erro HTTP da OpenAI: a resposta não traz a mensagem do provedor', async () => {
    providerReply = { status: 400, raw: JSON.stringify({ error: { message: PROVIDER_SECRET_TEXT } }) };
    const res = await ask('pergunta-do-usuario-777');
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'fallback');
    assert.equal(res.body.fallback_reason, 'openai_unavailable');
    assert.equal(res.raw.includes(PROVIDER_SECRET_TEXT), false);
    assert.equal(loggedText().includes(PROVIDER_SECRET_TEXT), false);
    assert.equal(loggedText().includes('pergunta-do-usuario-777'), false);
    assert.match(loggedText(), /openai_http_error/);
  });

  test('resposta quebrada da OpenAI: nada do texto dela volta nem vai ao log', async () => {
    providerReply = { status: 200, raw: `nao-e-json ${PROVIDER_SECRET_TEXT}` };
    const res = await ask('o que faco hoje?');
    assert.equal(res.body.fallback_reason, 'openai_unavailable');
    assert.equal(res.raw.includes(PROVIDER_SECRET_TEXT), false);
    assert.equal(loggedText().includes(PROVIDER_SECRET_TEXT), false);
    assert.match(loggedText(), /openai_bad_response/);
  });

  test('erro de rede: código fixo, sem a mensagem do erro', async () => {
    providerReply = { network: true };
    const res = await ask('o que faco hoje?');
    assert.equal(res.body.fallback_reason, 'openai_unavailable');
    assert.equal(res.raw.includes(PROVIDER_SECRET_TEXT), false);
    assert.equal(loggedText().includes(PROVIDER_SECRET_TEXT), false);
    assert.match(loggedText(), /openai_network_error/);
  });

  test('erro do banco: 500 sem details e sem a mensagem do erro no log', async () => {
    state.dbFails = true;
    const res = await ask('o que faco hoje?');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'assistant_failed');
    assert.equal('details' in res.body, false);
    assert.equal(res.raw.includes('relation'), false);
    assert.equal(loggedText().includes('relation'), false);
    assert.equal(loggedText().includes('matar'), false);
    assert.equal(sent.length, 0);
  });
});
