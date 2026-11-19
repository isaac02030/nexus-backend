const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';
process.env.MATCHING_ENABLED = 'false';
process.env.NEXUS_CONVITE_POR_LINK = 'true';

const missionsRouter = require('../routes/missions');
const { missionInvites, convites, INVITE_TTL_HOURS } = require('../routes/invites');

const app = express();
app.use(express.json());
app.use('/api/missions', missionsRouter);
app.use('/api/missions', missionInvites);
app.use('/api/convites', convites);

const state = {
  missions: [],
  users: [],
  invites: [],
  nextInviteId: 1,
  queries: []
};

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function sha256(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function findMission(id) {
  return state.missions.find((mission) => Number(mission.id) === Number(id));
}

function findUser(id) {
  return state.users.find((user) => Number(user.id) === Number(id));
}

function pendingUnexpired(invite) {
  return invite
    && invite.status === 'pending'
    && new Date(invite.expires_at).getTime() > Date.now();
}

function missionIsOpen(mission) {
  return mission
    && mission.partner_id == null
    && (mission.status === 'active' || mission.status === 'waiting');
}

function remember(undo, target, previous) {
  if (undo) undo.push(() => Object.assign(target, previous));
}

function handleQuery(sql, params = [], undo = null) {
  const text = normalize(sql);
  state.queries.push({ text, params });

  if (/^BEGIN\b/i.test(text)) return { rows: [], rowCount: 0 };
  if (/^COMMIT\b/i.test(text)) {
    if (undo) undo.length = 0;
    return { rows: [], rowCount: 0 };
  }
  if (/^ROLLBACK\b/i.test(text)) {
    if (undo) {
      while (undo.length) undo.pop()();
    }
    return { rows: [], rowCount: 0 };
  }

  if (/^SELECT id, user_id, partner_id, status, mode FROM missions/i.test(text)) {
    const mission = findMission(params[0]);
    if (!mission || Number(mission.user_id) !== Number(params[1])) {
      return { rows: [], rowCount: 0 };
    }
    return {
      rows: [{
        id: mission.id,
        user_id: mission.user_id,
        partner_id: mission.partner_id,
        status: mission.status,
        mode: mission.mode
      }],
      rowCount: 1
    };
  }

  if (/^INSERT INTO mission_invites/i.test(text)) {
    const invite = {
      id: state.nextInviteId,
      mission_id: Number(params[0]),
      inviter_id: Number(params[1]),
      code_hash: params[2],
      status: 'pending',
      expires_at: new Date(params[3]),
      used_by: null,
      used_at: null,
      declined_at: null
    };
    state.nextInviteId += 1;
    state.invites.push(invite);
    return { rows: [{ id: invite.id, expires_at: invite.expires_at }], rowCount: 1 };
  }

  if (/SELECT u\.username AS display_name, m\.title AS mission_title/i.test(text)) {
    const invite = state.invites.find((item) => item.code_hash === params[0]);
    const mission = invite && findMission(invite.mission_id);
    const user = invite && findUser(invite.inviter_id);
    if (!invite || !pendingUnexpired(invite) || !missionIsOpen(mission) || !user) {
      return { rows: [], rowCount: 0 };
    }
    return {
      rows: [{
        display_name: user.username,
        mission_title: mission.title,
        email: user.email,
        bio: user.bio,
        avatar_url: user.avatar_url,
        user_id: user.id,
        description: mission.description,
        category: mission.category
      }],
      rowCount: 1
    };
  }

  if (/FOR UPDATE OF i, m/i.test(text)) {
    const invite = state.invites.find((item) => item.code_hash === params[0]);
    if (!invite) return { rows: [], rowCount: 0 };
    const mission = findMission(invite.mission_id);
    const user = findUser(invite.inviter_id);
    if (!mission || !user) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        id: invite.id,
        mission_id: invite.mission_id,
        inviter_id: invite.inviter_id,
        status: invite.status,
        expires_at: invite.expires_at,
        user_id: mission.user_id,
        partner_id: mission.partner_id,
        mission_status: mission.status,
        mode: mission.mode,
        mission_title: mission.title,
        display_name: user.username,
        email: user.email,
        bio: user.bio,
        avatar_url: user.avatar_url,
        description: mission.description
      }],
      rowCount: 1
    };
  }

  if (/^UPDATE mission_invites SET status = 'used'/i.test(text)) {
    const invite = state.invites.find((item) => Number(item.id) === Number(params[0]));
    const allowed = invite
      && invite.status === 'pending'
      && new Date(invite.expires_at).getTime() > Date.now()
      && Number(invite.inviter_id) !== Number(params[1]);
    if (!allowed) return { rows: [], rowCount: 0 };
    const previous = { ...invite };
    invite.status = 'used';
    invite.used_by = Number(params[1]);
    invite.used_at = new Date();
    remember(undo, invite, previous);
    return { rows: [], rowCount: 1 };
  }

  if (/^UPDATE mission_invites SET status = 'declined'/i.test(text)) {
    const invite = state.invites.find((item) => Number(item.id) === Number(params[0]));
    const allowed = invite
      && invite.status === 'pending'
      && new Date(invite.expires_at).getTime() > Date.now()
      && Number(invite.inviter_id) !== Number(params[1]);
    if (!allowed) return { rows: [], rowCount: 0 };
    const previous = { ...invite };
    invite.status = 'declined';
    invite.declined_at = new Date();
    remember(undo, invite, previous);
    return { rows: [], rowCount: 1 };
  }

  if (/^UPDATE missions SET partner_id/i.test(text)) {
    const mission = findMission(params[0]);
    const userId = Number(params[1]);
    const allowed = mission
      && mission.partner_id == null
      && Number(mission.user_id) !== userId
      && (mission.status === 'active' || mission.status === 'waiting');
    if (!allowed) return { rows: [], rowCount: 0 };
    const previous = { ...mission };
    mission.partner_id = userId;
    mission.mode = 'parceiro';
    mission.status = 'active';
    mission.match_preference = null;
    if (!mission.pair_started_at) mission.pair_started_at = new Date();
    if (!mission.started_at) mission.started_at = new Date();
    remember(undo, mission, previous);
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`SQL inesperada no teste: ${text}`);
}

function user(overrides) {
  return {
    id: 1,
    username: 'alfa',
    email: 'alfa@example.com',
    bio: 'nota-privada',
    avatar_url: 'https://example.com/foto.png',
    ...overrides
  };
}

function mission(overrides) {
  return {
    id: 10,
    user_id: 1,
    partner_id: null,
    title: 'leitura diaria',
    description: 'detalhe privado da missao',
    category: 'estudo',
    status: 'active',
    mode: 'solo',
    match_preference: null,
    started_at: '2026-11-01T00:00:00.000Z',
    pair_started_at: null,
    ...overrides
  };
}

function useState(missions, users = [user(), user({ id: 2, username: 'beta', email: 'beta@example.com' })]) {
  state.missions = missions.map((item) => ({ ...item }));
  state.users = users.map((item) => ({ ...item }));
  state.invites = [];
  state.nextInviteId = 1;
  state.queries = [];
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

const NOT_FOUND = { error: 'Convite não encontrado.' };
const MISSION_NOT_FOUND = { error: 'Missão não encontrada.' };

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
  let parsed = {};
  if (raw) parsed = JSON.parse(raw);
  return { status: response.status, body: parsed, raw };
}

async function createInvite(missionId = 10, userId = 1) {
  return request('POST', `/api/missions/${missionId}/convite`, { token: tokenFor(userId) });
}

describe('convite de duo', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', (sql, params) => handleQuery(sql, params, null));
    mock.method(Pool.prototype, 'connect', async () => {
      const undo = [];
      return {
        query: (sql, params) => handleQuery(sql, params, undo),
        release() {}
      };
    });
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('a validade padrao continua 48 horas', () => {
    assert.equal(INVITE_TTL_HOURS, 48);
  });

  test('dono de solo ativa cria um codigo de uso unico e o banco guarda so o hash', async () => {
    useState([mission()]);

    const created = await createInvite();
    const again = await createInvite();

    assert.equal(created.status, 201);
    assert.match(created.body.code, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.body.path, `/convite/${created.body.code}`);
    assert.notEqual(created.body.code, again.body.code);
    const expiresAt = new Date(created.body.expires_at).getTime();
    const expected = Date.now() + 48 * 60 * 60 * 1000;
    assert.ok(Math.abs(expiresAt - expected) < 5000);

    assert.equal(state.invites.length, 2);
    for (const invite of state.invites) {
      assert.equal(invite.code_hash, sha256(
        invite.id === state.invites[0].id ? created.body.code : again.body.code
      ));
      assert.equal(JSON.stringify(invite).includes(created.body.code), false);
      assert.equal(JSON.stringify(invite).includes(again.body.code), false);
    }
    const insert = state.queries.find((query) => /^INSERT INTO mission_invites/i.test(query.text));
    assert.equal(insert.params.includes(created.body.code), false);
    assert.equal(insert.params[2], sha256(created.body.code));
  });

  test('dono de duo a espera tambem cria convite', async () => {
    useState([mission({ status: 'waiting', mode: 'duo' })]);

    const created = await createInvite();

    assert.equal(created.status, 201);
    assert.match(created.body.code, /^[A-Za-z0-9_-]{43}$/);
  });

  test('quem nao e dono recebe o mesmo 404 de missao inexistente', async () => {
    useState([mission()]);

    const stranger = await createInvite(10, 2);
    const missing = await createInvite(999, 2);

    assert.equal(stranger.status, 404);
    assert.deepEqual(stranger.body, missing.body);
    assert.deepEqual(stranger.body, MISSION_NOT_FOUND);
    assert.equal(state.invites.length, 0);
  });

  test('missao com parceiro ou encerrada nao recebe convite', async () => {
    useState([mission({ partner_id: 2, mode: 'parceiro' })]);
    const taken = await createInvite();
    assert.equal(taken.status, 400);
    assert.deepEqual(taken.body, { error: 'Esta missão não pode receber convite.' });

    useState([mission({ status: 'completed' })]);
    const closed = await createInvite();
    assert.equal(closed.status, 400);
    assert.equal(state.invites.length, 0);
  });

  test('previa mostra so o nome e o titulo', async () => {
    useState([mission()]);
    const created = await createInvite();
    const preview = await request('GET', `/api/convites/${created.body.code}`, { token: tokenFor(2) });

    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, {
      display_name: 'alfa',
      mission_title: 'leitura diaria'
    });
    assert.deepEqual(Object.keys(preview.body), ['display_name', 'mission_title']);
    assert.equal(preview.raw.includes('alfa@example.com'), false);
    assert.equal(preview.raw.includes('nota-privada'), false);
    assert.equal(preview.raw.includes('foto.png'), false);
    assert.equal(preview.raw.includes('detalhe privado'), false);
    assert.equal(preview.raw.includes('estudo'), false);
  });

  test('aceitar grava partner_id e marca o convite como usado', async () => {
    useState([mission()]);
    const created = await createInvite();
    const accepted = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(2)
    });

    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, {
      accepted: true,
      mission_id: 10,
      partner_id: 2,
      mode: 'parceiro',
      mission_title: 'leitura diaria'
    });
    assert.equal(accepted.raw.includes('alfa@example.com'), false);
    assert.equal(state.missions[0].partner_id, 2);
    assert.equal(state.missions[0].mode, 'parceiro');
    assert.equal(state.missions[0].status, 'active');
    assert.equal(state.missions[0].started_at, '2026-11-01T00:00:00.000Z');
    assert.ok(state.missions[0].pair_started_at);
    assert.equal(state.invites[0].status, 'used');
    assert.equal(state.invites[0].used_by, 2);
  });

  test('aceitar um duo a espera ativa a missao em parceiro', async () => {
    useState([mission({ status: 'waiting', mode: 'duo', started_at: null })]);
    const created = await createInvite();
    const accepted = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(2)
    });

    assert.equal(accepted.status, 200);
    assert.equal(state.missions[0].partner_id, 2);
    assert.equal(state.missions[0].mode, 'parceiro');
    assert.equal(state.missions[0].status, 'active');
    assert.ok(state.missions[0].started_at);
  });

  test('o segundo aceite e bloqueado e recebe o mesmo 404', async () => {
    useState([
      mission()
    ], [
      user(),
      user({ id: 2, username: 'beta', email: 'beta@example.com' }),
      user({ id: 3, username: 'gama', email: 'gama@example.com' })
    ]);
    const created = await createInvite();
    const unknownCode = 'b'.repeat(43);

    const first = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(2)
    });
    const second = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(3)
    });
    const missing = await request('POST', `/api/convites/${unknownCode}/aceitar`, {
      token: tokenFor(3)
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 404);
    assert.deepEqual(second.body, missing.body);
    assert.deepEqual(second.body, NOT_FOUND);
    assert.equal(state.missions[0].partner_id, 2);
    assert.equal(state.invites.filter((invite) => invite.status === 'used').length, 1);
    assert.equal(state.invites[0].used_by, 2);
  });

  test('dois aceites ao mesmo tempo deixam um so parceiro', async () => {
    useState([
      mission()
    ], [
      user(),
      user({ id: 2, username: 'beta', email: 'beta@example.com' }),
      user({ id: 3, username: 'gama', email: 'gama@example.com' })
    ]);
    const created = await createInvite();

    const [left, right] = await Promise.all([
      request('POST', `/api/convites/${created.body.code}/aceitar`, { token: tokenFor(2) }),
      request('POST', `/api/convites/${created.body.code}/aceitar`, { token: tokenFor(3) })
    ]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);

    assert.deepEqual(statuses, [200, 404]);
    assert.ok(state.missions[0].partner_id === 2 || state.missions[0].partner_id === 3);
    assert.equal(state.invites.filter((invite) => invite.status === 'used').length, 1);
    assert.equal(state.invites[0].used_by, state.missions[0].partner_id);
    const loser = left.status === 404 ? left : right;
    assert.deepEqual(loser.body, NOT_FOUND);
  });

  test('convite expirado responde igual a codigo inexistente', async () => {
    useState([mission()]);
    const created = await createInvite();
    state.invites[0].expires_at = new Date(Date.now() - 1000);
    const unknownCode = 'c'.repeat(43);

    const preview = await request('GET', `/api/convites/${created.body.code}`, { token: tokenFor(2) });
    const previewMissing = await request('GET', `/api/convites/${unknownCode}`, { token: tokenFor(2) });
    const accepted = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(2)
    });
    const acceptMissing = await request('POST', `/api/convites/${unknownCode}/aceitar`, {
      token: tokenFor(2)
    });

    assert.equal(preview.status, 404);
    assert.equal(accepted.status, 404);
    assert.deepEqual(preview.body, previewMissing.body);
    assert.deepEqual(accepted.body, acceptMissing.body);
    assert.deepEqual(preview.body, NOT_FOUND);
    assert.deepEqual(accepted.body, NOT_FOUND);
    assert.equal(state.invites[0].status, 'pending');
    assert.equal(state.missions[0].partner_id, null);
  });

  test('o dono nao aceita o proprio convite', async () => {
    useState([mission()]);
    const created = await createInvite();

    const own = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(1)
    });

    assert.equal(own.status, 403);
    assert.deepEqual(own.body, { error: 'Você não pode aceitar o seu próprio convite.' });
    assert.equal(state.invites[0].status, 'pending');
    assert.equal(state.missions[0].partner_id, null);

    const other = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(2)
    });

    assert.equal(other.status, 200);
    assert.equal(state.invites[0].status, 'used');
    assert.equal(state.missions[0].partner_id, 2);
  });

  test('o dono nao recusa o proprio convite', async () => {
    useState([mission()]);
    const created = await createInvite();

    const own = await request('POST', `/api/convites/${created.body.code}/recusar`, {
      token: tokenFor(1)
    });

    assert.equal(own.status, 403);
    assert.deepEqual(own.body, { error: 'Você não pode recusar o seu próprio convite.' });
    assert.equal(state.invites[0].status, 'pending');
    assert.equal(state.missions[0].partner_id, null);
  });

  test('recusar marca o convite e o aceite seguinte recebe o mesmo 404', async () => {
    useState([mission()]);
    const created = await createInvite();
    const unknownCode = 'd'.repeat(43);

    const declined = await request('POST', `/api/convites/${created.body.code}/recusar`, {
      token: tokenFor(2)
    });
    const accepted = await request('POST', `/api/convites/${created.body.code}/aceitar`, {
      token: tokenFor(2)
    });
    const missing = await request('POST', `/api/convites/${unknownCode}/aceitar`, {
      token: tokenFor(2)
    });

    assert.equal(declined.status, 200);
    assert.deepEqual(declined.body, { declined: true });
    assert.equal(state.invites[0].status, 'declined');
    assert.ok(state.invites[0].declined_at);
    assert.equal(state.missions[0].partner_id, null);
    assert.equal(accepted.status, 404);
    assert.deepEqual(accepted.body, missing.body);
    assert.deepEqual(accepted.body, NOT_FOUND);
  });

  test('com o interruptor desligado as rotas respondem 404', async () => {
    useState([mission()]);
    const previous = process.env.NEXUS_CONVITE_POR_LINK;
    process.env.NEXUS_CONVITE_POR_LINK = 'false';
    state.queries = [];

    try {
      const created = await createInvite();
      const preview = await request('GET', `/api/convites/${'a'.repeat(43)}`, { token: tokenFor(2) });
      const accepted = await request('POST', `/api/convites/${'a'.repeat(43)}/aceitar`, {
        token: tokenFor(2)
      });
      const declined = await request('POST', `/api/convites/${'a'.repeat(43)}/recusar`, {
        token: tokenFor(2)
      });
      const anonymous = await request('GET', `/api/convites/${'a'.repeat(43)}`);

      for (const response of [created, preview, accepted, declined, anonymous]) {
        assert.equal(response.status, 404);
        assert.deepEqual(response.body, NOT_FOUND);
      }
      assert.equal(state.queries.some((query) => /mission_invites/i.test(query.text)), false);
      assert.equal(state.invites.length, 0);
    } finally {
      process.env.NEXUS_CONVITE_POR_LINK = previous;
    }
  });

  test('sem login as rotas respondem 401', async () => {
    useState([mission()]);
    process.env.NEXUS_CONVITE_POR_LINK = 'true';
    const denied = { error: 'Acesso negado. Token não fornecido.' };

    const created = await request('POST', '/api/missions/10/convite');
    const preview = await request('GET', `/api/convites/${'e'.repeat(43)}`);
    const accepted = await request('POST', `/api/convites/${'e'.repeat(43)}/aceitar`);
    const declined = await request('POST', `/api/convites/${'e'.repeat(43)}/recusar`);

    for (const response of [created, preview, accepted, declined]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, denied);
    }
    assert.equal(state.invites.length, 0);
  });
});
