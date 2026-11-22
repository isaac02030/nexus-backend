// A nota do check-in é só do autor e não vai para a IA (decisão de 22/11).
// Banco simulado; a chamada à OpenAI é interceptada (nada sai da máquina).
const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';
process.env.MATCHING_ENABLED = 'false';

const checkinsRouter = require('../routes/checkins');
const assistantRouter = require('../routes/assistant');

const app = express();
app.use(express.json());
app.use('/api/checkins', checkinsRouter);
app.use('/api/assistant', assistantRouter);

const NOTA_DO_AUTOR = 'nota-secreta-do-autor-111';
const NOTA_DO_PARCEIRO = 'nota-secreta-do-parceiro-222';

const state = { missions: [], pair: null, checkins: [] };

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function isMember(mission, userId) {
  return Number(mission.user_id) === userId
    || (mission.partner_id != null && Number(mission.partner_id) === userId);
}

function handleQuery(sql, params = []) {
  const text = normalize(sql);

  if (/FROM mission_matches/i.test(text)) {
    const id = Number(params[0]);
    const pair = state.pair;
    if (pair && (pair.mission_a_id === id || pair.mission_b_id === id)) return { rows: [{ ...pair }] };
    return { rows: [] };
  }

  if (/FROM missions/i.test(text)) {
    const mission = state.missions.find((item) => Number(item.id) === Number(params[0]));
    if (!mission || !isMember(mission, Number(params[1]))) return { rows: [] };
    return { rows: [{ ...mission }] };
  }

  if (/FROM checkins c JOIN users u/i.test(text)) {
    const ids = params[0].map(Number);
    return {
      rows: state.checkins
        .filter((row) => ids.includes(row.mission_id))
        .map((row) => ({ ...row, username: row.user_id === 1 ? 'alfa' : 'beta' }))
    };
  }

  if (/FROM checkins/i.test(text)) {
    return {
      rows: state.checkins
        .filter((row) => row.mission_id === Number(params[0]) && row.user_id === Number(params[1]))
        .map((row) => ({ ...row }))
    };
  }

  return { rows: [] };
}

function checkin(missionId, userId, day, note) {
  return {
    id: missionId * 100 + userId * 10 + day,
    mission_id: missionId,
    user_id: userId,
    day_number: day,
    completed: true,
    note,
    is_difficult: false,
    created_at: new Date(2026, 10, day).toISOString()
  };
}

function mission(overrides) {
  return {
    id: 10,
    user_id: 1,
    partner_id: 2,
    status: 'active',
    mode: 'parceiro',
    category: 'habito',
    level: 'base',
    proof_mode: 'self_report',
    title: 'caminhar',
    why_it_matters: 'porque-sim',
    started_at: new Date().toISOString(),
    duration_days: 30,
    ...overrides
  };
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

let server;
let baseUrl;

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

function checkinsOf(body, userId) {
  return body.progress[userId].checkins;
}

describe('nota do check-in é só do autor', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb((sql, params) => handleQuery(sql, params)));
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('Duo na mesma missão: cada um vê só a própria nota', async () => {
    state.missions = [mission()];
    state.pair = null;
    state.checkins = [checkin(10, 1, 1, NOTA_DO_AUTOR), checkin(10, 2, 1, NOTA_DO_PARCEIRO)];

    const doAutor = await request('GET', '/api/checkins/10', { token: tokenFor(1) });
    assert.equal(doAutor.status, 200);
    assert.equal(checkinsOf(doAutor.body, 1)[0].note, NOTA_DO_AUTOR);
    assert.equal('note' in checkinsOf(doAutor.body, 2)[0], false);
    assert.deepEqual(checkinsOf(doAutor.body, 2)[0], { day: 1, completed: true, difficult: false });
    assert.equal(JSON.stringify(doAutor.body).includes(NOTA_DO_PARCEIRO), false);

    const doParceiro = await request('GET', '/api/checkins/10', { token: tokenFor(2) });
    assert.equal(doParceiro.status, 200);
    assert.equal(checkinsOf(doParceiro.body, 2)[0].note, NOTA_DO_PARCEIRO);
    assert.equal('note' in checkinsOf(doParceiro.body, 1)[0], false);
    assert.equal(JSON.stringify(doParceiro.body).includes(NOTA_DO_AUTOR), false);
  });

  test('par entre duas missões (Duo/Rival por match): a nota do outro não vem', async () => {
    state.missions = [
      mission({ id: 10, partner_id: null, mode: 'rival' }),
      mission({ id: 11, user_id: 2, partner_id: null, mode: 'rival' })
    ];
    state.pair = { mission_a_id: 10, mission_b_id: 11 };
    state.checkins = [checkin(10, 1, 3, NOTA_DO_AUTOR), checkin(11, 2, 3, NOTA_DO_PARCEIRO)];

    const response = await request('GET', '/api/checkins/10', { token: tokenFor(1) });
    assert.equal(response.status, 200);
    assert.equal(checkinsOf(response.body, 1)[0].note, NOTA_DO_AUTOR);
    assert.deepEqual(checkinsOf(response.body, 2)[0], { day: 3, completed: true, difficult: false });
    assert.equal(JSON.stringify(response.body).includes(NOTA_DO_PARCEIRO), false);
  });

  test('quem não participa e quem não tem login não recebem nada', async () => {
    state.missions = [mission()];
    state.pair = null;
    state.checkins = [checkin(10, 1, 1, NOTA_DO_AUTOR)];

    const outsider = await request('GET', '/api/checkins/10', { token: tokenFor(8) });
    assert.equal(outsider.status, 404);
    assert.equal(JSON.stringify(outsider.body).includes(NOTA_DO_AUTOR), false);

    const semLogin = await request('GET', '/api/checkins/10');
    assert.equal(semLogin.status, 401);
  });
});

describe('a IA não recebe as notas do check-in', { concurrency: 1 }, () => {
  const sentBodies = [];
  const originalKey = process.env.OPENAI_API_KEY;

  before(async () => {
    process.env.OPENAI_API_KEY = 'chave-falsa-de-teste';
    mock.method(Pool.prototype, 'query', withAuthDb((sql, params) => handleQuery(sql, params)));
    // Intercepta a ida à OpenAI: guarda o corpo e responde como a API, sem rede.
    mock.method(https, 'request', (options, onResponse) => {
      const req = new EventEmitter();
      let body = '';
      req.setTimeout = () => req;
      req.write = (chunk) => { body += chunk; };
      req.destroy = () => {};
      req.end = () => {
        sentBodies.push({ host: options.hostname, body });
        const res = new EventEmitter();
        res.statusCode = 200;
        onResponse(res);
        res.emit('data', JSON.stringify({ output_text: 'resposta de teste' }));
        res.emit('end');
      };
      return req;
    });
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('o pedido à OpenAI leva título e porquê, mas nenhuma nota', async () => {
    state.missions = [mission({ partner_id: null, mode: 'solo' })];
    state.pair = null;
    state.checkins = [checkin(10, 1, 1, NOTA_DO_AUTOR), checkin(10, 1, 2, NOTA_DO_AUTOR + '-dia2')];
    sentBodies.length = 0;

    const response = await request('POST', '/api/assistant/mission', {
      token: tokenFor(1),
      body: { mission_id: 10, question: 'o que faco hoje?' }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.source, 'openai');
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0].host, 'api.openai.com');
    const sent = sentBodies[0].body;
    assert.equal(sent.includes('nota-secreta'), false);
    assert.equal(/Notas\/check-ins/i.test(sent), false);
    assert.equal(sent.includes('caminhar'), true);
    assert.equal(sent.includes('porque-sim'), true);
  });

  test('o prompt montado não depende dos check-ins', () => {
    const prompt = assistantRouter.buildMissionContext(mission(), 'pergunta');
    assert.equal(prompt.includes('caminhar'), true);
    assert.equal(prompt.includes('porque-sim'), true);
    assert.equal(/nota/i.test(prompt), false);
  });
});
