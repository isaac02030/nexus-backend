const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const communityMissionsRouter = require('../routes/community-missions');
const checkinsRouter = require('../routes/checkins');

const app = express();
app.use(express.json());
app.use('/api/community-missions', communityMissionsRouter);
app.use('/api/checkins', checkinsRouter);

const state = {
  communityMissions: [],
  participants: [],
  missions: [],
  queries: [],
  notAdult: new Set()
};

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function communityMissionById(id) {
  return state.communityMissions.find((mission) => Number(mission.id) === Number(id));
}

function isCommunityParticipant(missionId, userId) {
  return state.participants.some((row) =>
    Number(row.community_mission_id) === Number(missionId)
    && Number(row.user_id) === Number(userId)
  );
}

function handleQuery(sql, params = []) {
  const text = normalize(sql);
  state.queries.push({ text, params });

  // 18+ confirmado no cadastro (todo mundo, menos quem está em notAdult).
  if (/adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !state.notAdult.has(Number(params[0])) }] };
  }

  if (/^INSERT INTO checkins/i.test(text)) {
    return {
      rows: [{
        id: 1,
        mission_id: params[0],
        user_id: params[1],
        day_number: params[2],
        completed: true,
        note: params[3] || null
      }],
      rowCount: 1
    };
  }

  if (!/^SELECT/i.test(text)) {
    return { rows: [], rowCount: 0 };
  }

  if (/FROM community_missions cm/i.test(text) && /community_mission_participants/i.test(text)) {
    const mission = communityMissionById(params[0]);
    if (!mission || !isCommunityParticipant(mission.id, params[1])) return { rows: [] };
    return { rows: [{ ...mission }] };
  }

  if (/FROM community_missions/i.test(text)) {
    const mission = communityMissionById(params[0]);
    return { rows: mission ? [{ ...mission }] : [] };
  }

  if (/FROM community_mission_participants/i.test(text) && /JOIN users/i.test(text)) {
    const rows = state.participants
      .filter((row) => Number(row.community_mission_id) === Number(params[0]))
      .sort((a, b) => b.score - a.score)
      .map((row, index) => ({
        score: row.score,
        completed: false,
        username: row.username,
        user_id: row.user_id,
        position: index + 1
      }));
    return { rows };
  }

  if (/FROM community_mission_participants/i.test(text)) {
    const row = state.participants.find((item) =>
      Number(item.community_mission_id) === Number(params[0])
      && Number(item.user_id) === Number(params[1])
    );
    return { rows: row ? [{ ...row }] : [] };
  }

  if (/FROM missions\b/i.test(text) && /FOR UPDATE/i.test(text)) {
    const mission = state.missions.find((item) => Number(item.id) === Number(params[0]));
    return { rows: mission ? [{ ...mission }] : [] };
  }

  if (/FROM missions m\b/i.test(text)) {
    const mission = state.missions.find((item) => Number(item.id) === Number(params[0]));
    if (!mission) return { rows: [] };
    const filtersMember = /user_id\s*=\s*\$\d+/i.test(text) && /partner_id\s*=\s*\$\d+/i.test(text);
    if (!filtersMember) return { rows: [{ ...mission }] };
    const requester = Number(params[1]);
    const member = Number(mission.user_id) === requester
      || (mission.partner_id != null && Number(mission.partner_id) === requester);
    return { rows: member ? [{ ...mission }] : [] };
  }

  return { rows: [] };
}

function inserted(table) {
  return state.queries.some((query) => new RegExp(`^INSERT INTO ${table}`, 'i').test(query.text));
}

function listedRanking() {
  return state.queries.some((query) => /JOIN users/i.test(query.text) && /community_mission_participants/i.test(query.text));
}

function communityMission(overrides) {
  return {
    id: 40,
    community_id: 3,
    title: 'constancia',
    status: 'active',
    scope: 'mundial',
    mode: 'maratona',
    starts_at: new Date().toISOString(),
    duration_days: 30,
    ...overrides
  };
}

function participant(overrides) {
  return {
    community_mission_id: 40,
    user_id: 1,
    username: 'alfa',
    score: 2,
    ...overrides
  };
}

function mission(overrides) {
  return {
    id: 11,
    user_id: 1,
    partner_id: null,
    status: 'active',
    mode: 'solo',
    proof_mode: 'self_report',
    started_at: new Date().toISOString(),
    duration_days: 30,
    ...overrides
  };
}

function useState({ communityMissions = [], participants = [], missions = [], notAdult = [] } = {}) {
  state.notAdult = new Set(notAdult);
  state.communityMissions = communityMissions;
  state.participants = participants;
  state.missions = missions;
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

describe('acesso a missão de comunidade', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', (sql, params) => handleQuery(sql, params));
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

  test('participante lê o ranking', async () => {
    useState({
      communityMissions: [communityMission()],
      participants: [participant(), participant({ user_id: 2, username: 'beta', score: 1 })]
    });

    const response = await request('GET', '/api/community-missions/foco/40/ranking', {
      token: tokenFor(1)
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.my_position, 1);
    assert.equal(response.body.total, 2);
    assert.deepEqual(response.body.ranking.map((row) => row.username), ['alfa', 'beta']);
    assert.equal(response.body.mission_scope, 'mundial');
  });

  test('quem não participa recebe a mesma resposta de missão inexistente', async () => {
    useState({
      communityMissions: [communityMission()],
      participants: [participant()]
    });

    const denied = await request('GET', '/api/community-missions/foco/40/ranking', {
      token: tokenFor(8)
    });
    const missing = await request('GET', '/api/community-missions/foco/999/ranking', {
      token: tokenFor(8)
    });

    assert.equal(denied.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(denied.body, missing.body);
    assert.deepEqual(denied.body, { error: 'Missão não encontrada.' });
    assert.equal(listedRanking(), false);
  });

  test('check-in em missão de comunidade inativa é recusado', async () => {
    useState({
      communityMissions: [communityMission({ status: 'open' })],
      participants: [participant()]
    });

    const response = await request('POST', '/api/community-missions/foco/40/checkin', {
      token: tokenFor(1)
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Missão não está ativa.' });
    assert.equal(inserted('checkins'), false);
  });

  test('participante ainda faz check-in em missão de comunidade ativa', async () => {
    useState({
      communityMissions: [communityMission({ status: 'active' })],
      participants: [participant()]
    });

    const response = await request('POST', '/api/community-missions/foco/40/checkin', {
      token: tokenFor(1)
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.already_done, false);
    assert.equal(response.body.day, 1);
    assert.equal(inserted('checkins'), true);
  });

  test('fluxo solo e duo permanece', async () => {
    useState({
      missions: [
        mission(),
        mission({ id: 12, user_id: 1, partner_id: 2, mode: 'parceiro' })
      ]
    });

    const solo = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 11 }
    });
    const duo = await request('POST', '/api/checkins', {
      token: tokenFor(2),
      body: { mission_id: 12 }
    });

    assert.equal(solo.status, 201);
    assert.equal(solo.body.day, 1);
    assert.equal(solo.body.already_done, false);
    assert.equal(duo.status, 201);
    assert.equal(duo.body.day, 1);
    assert.equal(duo.body.already_done, false);
  });

  // ---------- 18+ confirmado em todas as rotas de missão de comunidade ----------

  test('negado: sem 18+ confirmado, todas as rotas dão 403 com código e nada é gravado', async () => {
    useState({
      communityMissions: [communityMission()],
      participants: [participant({ user_id: 5 })],
      notAdult: [5]
    });
    const t = tokenFor(5);
    const calls = [
      ['GET', '/api/community-missions/foco'],
      ['POST', '/api/community-missions/foco', { title: 'x', mode: 'solo' }],
      ['POST', '/api/community-missions/foco/40/join'],
      ['POST', '/api/community-missions/foco/40/checkin'],
      ['GET', '/api/community-missions/foco/40/ranking'],
      ['GET', '/api/community-missions/foco/scope/mundial']
    ];
    for (const [method, path, body] of calls) {
      const res = await request(method, path, { token: t, body });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.code, 'adult_confirmation_required', `${method} ${path}`);
    }
    assert.equal(inserted('checkins'), false);
    assert.equal(inserted('community_missions'), false);
    assert.equal(inserted('community_mission_participants'), false);
    assert.equal(listedRanking(), false);
    // Só a pergunta da idade chegou ao banco.
    assert.ok(state.queries.every((q) => /adult_confirmed FROM users/.test(q.text)));
  });

  test('negado: sem login continua 401 antes do portão', async () => {
    useState({ communityMissions: [communityMission()], participants: [participant()] });
    const res = await request('GET', '/api/community-missions/foco/40/ranking');
    assert.equal(res.status, 401);
    assert.equal(state.queries.length, 0);
  });

  test('o check-in pessoal (/api/checkins) não depende do 18+ da comunidade', async () => {
    useState({ missions: [mission()], notAdult: [1] });
    const solo = await request('POST', '/api/checkins', { token: tokenFor(1), body: { mission_id: 11 } });
    assert.equal(solo.status, 201);
  });
});
