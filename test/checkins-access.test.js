const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';
process.env.MATCHING_ENABLED = 'false';

const checkinsRouter = require('../routes/checkins');
const messagesRouter = require('../routes/messages');
const missionsRouter = require('../routes/missions');

const app = express();
app.use(express.json());
app.use('/api/checkins', checkinsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/missions', missionsRouter);

const state = {
  missions: [],
  oldCheckins: new Set(),
  queries: []
};

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function grantsHistoricalMembership(text) {
  return /EXISTS\s*\(\s*SELECT 1 FROM checkins/i.test(text)
    || /EXISTS\s*\(\s*SELECT 1 FROM messages/i.test(text);
}

function isCurrentMember(mission, requester) {
  return Number(mission.user_id) === requester
    || (mission.partner_id != null && Number(mission.partner_id) === requester);
}

function matchingMissions(text, params) {
  const historical = grantsHistoricalMembership(text);
  const filtersMember = /user_id\s*=\s*\$\d+/i.test(text) && /partner_id\s*=\s*\$\d+/i.test(text);

  if (/status\s*<>\s*'merged'/i.test(text)) {
    const requester = Number(params[0]);
    return state.missions.filter((mission) => {
      if (mission.status === 'merged') return false;
      if (Number(mission.user_id) === requester) return true;
      if (mission.partner_id != null && Number(mission.partner_id) === requester && /pair\.id IS NULL/i.test(text)) {
        return true;
      }
      return historical && state.oldCheckins.has(`${mission.id}:${requester}`);
    }).map((mission) => ({ ...mission }));
  }

  const mission = state.missions.find((item) => Number(item.id) === Number(params[0]));
  if (!mission) return [];
  if (!filtersMember) return [{ ...mission }];

  const requester = Number(params[1]);
  if (isCurrentMember(mission, requester)) return [{ ...mission }];
  if (historical && state.oldCheckins.has(`${mission.id}:${requester}`)) return [{ ...mission }];
  return [];
}

function handleQuery(sql, params = []) {
  const text = normalize(sql);
  state.queries.push({ text, params });

  if (/^INSERT INTO checkins/i.test(text)) {
    return {
      rows: [{
        id: 1,
        mission_id: params[0],
        user_id: params[1],
        day_number: params[2],
        completed: true,
        note: params[3] || null
      }]
    };
  }

  if (/^INSERT INTO messages/i.test(text)) {
    return { rows: [{ id: 5 }] };
  }

  if (/FROM messages/i.test(text) && /INTERVAL '5 seconds'/i.test(text)) {
    return { rows: [] };
  }

  // Limite por hora e por dia do chat (PR B): ninguém perto do limite aqui.
  if (/FROM messages/i.test(text) && /INTERVAL '24 hours'/i.test(text)) {
    return { rows: [{ last_hour: '0', last_day: '0' }] };
  }

  if (/FROM messages m/i.test(text) && /WHERE m\.id = \$1/i.test(text)) {
    return {
      rows: [{
        id: params[0],
        mission_id: 10,
        sender_id: params[1] || 2,
        content: 'ainda aqui',
        sender_name: 'beta'
      }]
    };
  }

  if (!/^SELECT/i.test(text)) {
    return { rows: [], rowCount: 0 };
  }

  if (/FROM missions\b/i.test(text) && /FOR UPDATE/i.test(text)) {
    const mission = state.missions.find((item) => Number(item.id) === Number(params[0]));
    return { rows: mission ? [{ ...mission }] : [] };
  }

  if (/FROM missions m\b/i.test(text)) {
    return { rows: matchingMissions(text, params) };
  }

  return { rows: [] };
}

function inserted(table) {
  return state.queries.some((query) => new RegExp(`^INSERT INTO ${table}`, 'i').test(query.text));
}

function mission(overrides) {
  return {
    id: 10,
    user_id: 1,
    partner_id: 2,
    user_name: 'alfa',
    partner_name: 'beta',
    status: 'active',
    mode: 'parceiro',
    proof_mode: 'self_report',
    started_at: new Date().toISOString(),
    duration_days: 30,
    title: 'constancia',
    ...overrides
  };
}

function useMissions(missions, oldCheckins = []) {
  state.missions = missions;
  state.oldCheckins = new Set(oldCheckins);
  state.queries = [];
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

describe('acesso a missao', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb((sql, params) => handleQuery(sql, params)));
    mock.method(Pool.prototype, 'connect', () => ({
      query: (sql, params) => handleQuery(sql, params),
      release() {}
    }));
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('participante lê o placar', async () => {
    useMissions([mission()]);

    const response = await request('GET', '/api/checkins/10/score', { token: tokenFor(2) });

    assert.equal(response.status, 200);
    assert.equal(response.body.mission_id, 10);
    assert.equal(response.body.mode, 'parceiro');
    assert.deepEqual(response.body.scores, { alfa: 0, beta: 0 });
  });

  test('quem não participa recebe a mesma resposta de missão inexistente', async () => {
    useMissions([mission()]);

    const denied = await request('GET', '/api/checkins/10/score', { token: tokenFor(8) });
    const missing = await request('GET', '/api/checkins/999/score', { token: tokenFor(8) });

    assert.equal(denied.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(denied.body, missing.body);
    assert.deepEqual(denied.body, { error: 'Missão não encontrada.' });
  });

  test('ex-participante com check-in antigo não registra novo check-in', async () => {
    useMissions(
      [mission({ id: 12, user_id: 1, partner_id: null, partner_name: null, mode: 'solo' })],
      ['12:9']
    );

    const denied = await request('POST', '/api/checkins', {
      token: tokenFor(9),
      body: { mission_id: 12 }
    });
    const missing = await request('POST', '/api/checkins', {
      token: tokenFor(9),
      body: { mission_id: 999 }
    });

    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, missing.body);
    assert.deepEqual(denied.body, { error: 'Missão não encontrada.' });
    assert.equal(inserted('checkins'), false);
  });

  test('participante atual ainda registra check-in', async () => {
    useMissions([mission()]);

    const response = await request('POST', '/api/checkins', {
      token: tokenFor(2),
      body: { mission_id: 10 }
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.day, 1);
    assert.equal(response.body.already_done, false);
    assert.equal(inserted('checkins'), true);
  });

  test('fluxo solo permanece', async () => {
    useMissions([mission({
      id: 11,
      user_id: 1,
      partner_id: null,
      partner_name: null,
      mode: 'solo'
    })]);

    const created = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 11 }
    });
    const score = await request('GET', '/api/checkins/11/score', { token: tokenFor(1) });
    const streak = await request('GET', '/api/checkins/11/streak', { token: tokenFor(1) });
    const progress = await request('GET', '/api/checkins/11', { token: tokenFor(1) });

    assert.equal(created.status, 201);
    assert.equal(created.body.day, 1);
    assert.equal(score.status, 200);
    assert.equal(score.body.mode, 'solo');
    assert.equal(streak.status, 200);
    assert.equal(typeof streak.body.streak, 'number');
    assert.equal(progress.status, 200);
    assert.deepEqual(progress.body.progress, {});
  });

  test('participante atual de missão inativa continua recebendo a recusa já existente', async () => {
    useMissions([mission({ id: 13, status: 'completed', partner_id: null, partner_name: null, mode: 'solo' })]);

    const response = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 13 }
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Missão não está ativa.' });
    assert.equal(inserted('checkins'), false);
  });

  test('ex-participante não envia mensagem e participante atual envia', async () => {
    useMissions(
      [mission({ id: 12, user_id: 1, partner_id: null, partner_name: null, mode: 'solo' })],
      ['12:9']
    );

    const denied = await request('POST', '/api/messages', {
      token: tokenFor(9),
      body: { mission_id: 12, content: 'ainda aqui' }
    });
    const stranger = await request('POST', '/api/messages', {
      token: tokenFor(8),
      body: { mission_id: 12, content: 'ainda aqui' }
    });

    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, stranger.body);
    assert.deepEqual(denied.body, { error: 'Sem acesso a esta missao.' });
    assert.equal(inserted('messages'), false);

    useMissions([
      mission(),
      mission({ id: 13, user_id: 1, status: 'completed', partner_id: null, partner_name: null, mode: 'solo' })
    ]);
    const allowed = await request('POST', '/api/messages', {
      token: tokenFor(2),
      body: { mission_id: 10, content: 'ainda aqui' }
    });
    const inactive = await request('POST', '/api/messages', {
      token: tokenFor(1),
      body: { mission_id: 13, content: 'ainda aqui' }
    });

    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.message.id, 5);
    assert.equal(inactive.status, 400);
    assert.deepEqual(inactive.body, { error: 'Missao nao esta ativa.' });
  });

  test('detalhe e lista da missão ignoram check-in antigo', async () => {
    const leftBehind = mission({ id: 12, user_id: 1, partner_id: null, partner_name: null, mode: 'solo' });
    useMissions([leftBehind], ['12:9']);

    const owner = await request('GET', '/api/missions/12', { token: tokenFor(1) });
    const former = await request('GET', '/api/missions/12', { token: tokenFor(9) });
    const missing = await request('GET', '/api/missions/999', { token: tokenFor(9) });
    const ownerList = await request('GET', '/api/missions', { token: tokenFor(1) });
    const formerList = await request('GET', '/api/missions', { token: tokenFor(9) });

    assert.equal(owner.status, 200);
    assert.equal(owner.body.id, 12);
    assert.equal(former.status, 404);
    assert.deepEqual(former.body, missing.body);
    assert.deepEqual(former.body, { error: 'Missao nao encontrada.' });
    assert.equal(ownerList.status, 200);
    assert.deepEqual(ownerList.body.map((item) => item.id), [12]);
    assert.equal(formerList.status, 200);
    assert.deepEqual(formerList.body, []);
  });
});
