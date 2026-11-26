const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';
process.env.MATCHING_ENABLED = 'false';

// Convite por link para o Duo e o Rival (PR 2 do plano do Rival; migração 012
// NÃO aplicada). Banco simulado com trava de linha (FOR UPDATE) e ROLLBACK de
// verdade, para a corrida de dois aceites ser medida.
const invitesRouter = require('../routes/invites');
const { ACCOUNT_DELETION_STEPS } = require('../lib/account-deletion');
const MSG = invitesRouter.MSG;

const app = express();
app.use(express.json());
app.use('/api/invites', invitesRouter);

const DAY = 24 * 60 * 60 * 1000;
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const db = {};

function resetDb() {
  db.migrated012 = true;
  db.migrated011 = true;
  db.adult = new Set([1, 2, 3, 5, 6, 7]);
  db.names = new Map([[1, 'dono'], [2, 'convidada'], [3, 'outra'], [4, 'menor'], [5, 'empar'], [6, 'bloqueada'], [7, 'terceira'], [8, 'par-de-5']]);
  db.missions = [
    { id: 100, user_id: 1, partner_id: null, mode: 'solo', status: 'active', title: 'Ler uma página', category: 'estudo', level: 'iniciante', daily_minimum: 'Uma página', why_it_matters: 'motivo pessoal do dono', fallback_plan: 'plano pessoal', proof_mode: 'self_report', duration_days: 30, pair_started_at: null, match_preference: null },
    { id: 200, user_id: 2, partner_id: null, mode: 'solo', status: 'active', title: 'Correr', category: 'fitness', level: 'iniciante', duration_days: 30, pair_started_at: null },
    { id: 300, user_id: 5, partner_id: 8, mode: 'parceiro', status: 'active', title: 'Par', category: 'estudo', duration_days: 30, pair_started_at: new Date() },
    { id: 400, user_id: 4, partner_id: null, mode: 'solo', status: 'active', title: 'Menor', category: 'estudo', duration_days: 30 },
    { id: 500, user_id: 3, partner_id: null, mode: 'solo', status: 'completed', title: 'Acabou', category: 'estudo', duration_days: 30 }
  ];
  db.matches = [];
  db.invites = [];
  db.blocks = [{ blocker_id: 1, blocked_id: 6 }];
  db.queries = [];
  db.locks = new Map();
  db.nextMission = 900;
  db.slow = 0;
}

const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const missing = () => Object.assign(new Error('relation does not exist'), { code: '42P01' });
const mission = (id) => db.missions.find((m) => m.id === Number(id));
const paired = (m) => m.partner_id != null || db.matches.some((mm) => mm.status === 'active' && (mm.mission_a_id === m.id || mm.mission_b_id === m.id));
const inviteView = (i) => ({ ...i, expired: i.expires_at.getTime() <= Date.now() });

function connection() {
  const held = new Set();
  let undo = [];
  // Espera a trava; se esperar demais, é deadlock (como o 40P01 do Postgres).
  const lock = async (key) => {
    const start = Date.now();
    while (db.locks.has(key) && db.locks.get(key) !== held) {
      if (Date.now() - start > 300) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    db.locks.set(key, held);
    held.add(key);
  };
  const releaseAll = () => {
    for (const key of held) db.locks.delete(key);
    held.clear();
  };
  const change = (obj, fields) => {
    const before = {};
    for (const k of Object.keys(fields)) before[k] = obj[k];
    undo.push(() => Object.assign(obj, before));
    Object.assign(obj, fields);
  };
  const push = (list, row) => {
    undo.push(() => list.splice(list.indexOf(row), 1));
    list.push(row);
  };

  async function query(sql, params = []) {
    const text = normalize(sql);
    db.queries.push({ text, params });
    await new Promise((resolve) => setTimeout(resolve, db.slow));
    if (text === 'BEGIN') { undo = []; return { rows: [] }; }
    if (text === 'COMMIT') { undo = []; releaseAll(); return { rows: [] }; }
    if (text === 'ROLLBACK') { undo.reverse().forEach((f) => f()); undo = []; releaseAll(); return { rows: [] }; }
    if (!db.migrated012 && /mission_invites/.test(text)) throw missing();
    if (!db.migrated011 && /FROM user_blocks/.test(text)) throw missing();

    if (/adult_confirmed_at/.test(text)) return { rows: [{ adult_confirmed: db.adult.has(Number(params[0])) }] };
    if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) { await lock(`user:${params[0]}`); return { rows: [{ id: params[0] }] }; }

    // Criar
    if (/^SELECT id FROM missions WHERE id = \$1 AND user_id = \$2$/.test(text)) {
      const m = mission(params[0]);
      return { rows: m && m.user_id === Number(params[1]) ? [{ id: m.id }] : [] };
    }
    if (/^SELECT id FROM mission_invites WHERE mission_id = \$1 AND used_at IS NULL AND canceled_at IS NULL FOR UPDATE$/.test(text)) {
      const open = db.invites.filter((i) => i.mission_id === Number(params[0]) && !i.used_at && !i.canceled_at);
      for (const i of open) await lock(`invite:${i.id}`);
      return { rows: open.map((i) => ({ id: i.id })) };
    }
    if (/^SELECT m\.id, m\.user_id, m\.status, m\.mode, .* FROM missions m WHERE m\.id = \$1 AND m\.user_id = \$2 FOR UPDATE$/.test(text)) {
      await lock(`mission:${params[0]}`);
      const m = mission(params[0]);
      return { rows: m && m.user_id === Number(params[1]) ? [{ ...m, paired: paired(m) }] : [] };
    }
    if (/^UPDATE mission_invites SET canceled_at = NOW\(\) WHERE mission_id = \$1/.test(text)) {
      // UPDATE também trava as linhas, como no Postgres.
      const open = db.invites.filter((i) => i.mission_id === Number(params[0]) && !i.used_at && !i.canceled_at);
      for (const i of open) await lock(`invite:${i.id}`);
      open.filter((i) => !i.used_at && !i.canceled_at).forEach((i) => change(i, { canceled_at: new Date() }));
      return { rows: [] };
    }
    if (/^INSERT INTO mission_invites/.test(text)) {
      assert.match(text, /NOW\(\) \+ INTERVAL '7 days'/, 'a validade de 7 dias usa o relógio do banco');
      const row = { id: db.invites.length + 1, mission_id: Number(params[0]), created_by: Number(params[1]), kind: params[2], token_hash: params[3], expires_at: new Date(Date.now() + 7 * DAY), used_at: null, used_by: null, canceled_at: null };
      push(db.invites, row);
      return { rows: [{ id: row.id, kind: row.kind, expires_at: row.expires_at }] };
    }

    // Cancelar
    if (/^UPDATE mission_invites SET canceled_at = NOW\(\) WHERE id = \$1 AND created_by = \$2/.test(text)) {
      const i = db.invites.find((x) => x.id === Number(params[0]) && x.created_by === Number(params[1]) && !x.used_at && !x.canceled_at);
      if (!i) return { rows: [] };
      change(i, { canceled_at: new Date() });
      return { rows: [{ id: i.id }] };
    }
    if (/^SELECT used_at, canceled_at FROM mission_invites WHERE id = \$1 AND created_by = \$2$/.test(text)) {
      const i = db.invites.find((x) => x.id === Number(params[0]) && x.created_by === Number(params[1]));
      return { rows: i ? [{ used_at: i.used_at, canceled_at: i.canceled_at }] : [] };
    }

    // Ver
    if (/^SELECT i\.kind, i\.created_by/.test(text)) {
      const i = db.invites.find((x) => x.token_hash === params[0]);
      if (!i) return { rows: [] };
      const m = mission(i.mission_id);
      return { rows: [{ ...inviteView(i), title: m.title, category: m.category, owner_name: db.names.get(i.created_by) }] };
    }

    // Aceitar
    if (/^SELECT id, mission_id, created_by, kind, used_at, canceled_at, .* FROM mission_invites WHERE token_hash = \$1( FOR UPDATE)?$/.test(text)) {
      const i = db.invites.find((x) => x.token_hash === params[0]);
      if (i && / FOR UPDATE$/.test(text)) await lock(`invite:${i.id}`);
      return { rows: i ? [inviteView(i)] : [] };
    }
    if (/to_regclass\('public\.user_blocks'\)/.test(text)) return { rows: [{ ready: db.migrated011 }] };
    if (/^SELECT 1 FROM user_blocks/.test(text)) {
      const [a, b] = params.map(Number);
      const hit = db.blocks.some((x) => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    if (/^SELECT 1 FROM missions m WHERE \(m\.user_id = \$1 OR m\.partner_id = \$1\) AND m\.status = 'active'/.test(text)) {
      const uid = Number(params[0]);
      const hit = db.missions.some((m) => (m.user_id === uid || m.partner_id === uid) && m.status === 'active' && paired(m));
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    if (/^SELECT m\.\*, .* AS paired FROM missions m WHERE m\.id = \$1( FOR UPDATE)?$/.test(text)) {
      if (/ FOR UPDATE$/.test(text)) await lock(`mission:${params[0]}`);
      const m = mission(params[0]);
      return { rows: m ? [{ ...m, paired: paired(m) }] : [] };
    }
    if (/^SELECT m\.\*, .* AS paired FROM missions m WHERE m\.id = \$1 AND m\.user_id = \$2 FOR UPDATE$/.test(text)) {
      await lock(`mission:${params[0]}`);
      const m = mission(params[0]);
      return { rows: m && m.user_id === Number(params[1]) ? [{ ...m, paired: paired(m) }] : [] };
    }
    if (/^UPDATE missions SET mode = 'parceiro', partner_id = \$2, pair_started_at = NOW\(\)/.test(text)) {
      change(mission(params[0]), { mode: 'parceiro', partner_id: Number(params[1]), pair_started_at: new Date(), match_preference: null });
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO missions/.test(text)) {
      const row = { id: db.nextMission++, user_id: Number(params[0]), partner_id: null, mode: 'solo', status: 'active', title: params[1], category: params[2], level: params[3], daily_minimum: params[4], proof_mode: params[5], duration_days: params[6], why_it_matters: null, fallback_plan: null };
      push(db.missions, row);
      return { rows: [{ ...row }] };
    }
    if (/^INSERT INTO mission_matches/.test(text)) {
      assert.match(text, /'rival', NOW\(\)/);
      push(db.matches, { mission_a_id: Number(params[0]), mission_b_id: Number(params[1]), mode: 'rival', status: 'active', started_at: new Date() });
      return { rows: [] };
    }
    if (/^UPDATE missions SET mode = 'rival', partner_id = \$2, pair_started_at = NOW\(\)/.test(text)) {
      change(mission(params[0]), { mode: 'rival', partner_id: Number(params[1]), pair_started_at: new Date(), match_preference: null });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE mission_invites SET used_at = NOW\(\), used_by = \$2 WHERE id = \$1$/.test(text)) {
      change(db.invites.find((i) => i.id === Number(params[0])), { used_at: new Date(), used_by: Number(params[1]) });
      return { rows: [] };
    }
    throw new Error(`SQL inesperada no teste: ${text}`);
  }
  return { query, release: releaseAll };
}

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);
let server;
let baseUrl;
const consoleCalls = [];

async function call(method, url, userId, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

const create = (userId, missionId = 100, kind = 'duo') => call('POST', '/api/invites', userId, { mission_id: missionId, kind });
const accept = (userId, token, extra = {}) => call('POST', '/api/invites/accept', userId, { token, ...extra });

describe('convite por link (Duo e Rival)', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => connection().query(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => connection());
    for (const name of ['log', 'error', 'warn', 'info', 'debug']) {
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
  });

  // ---------- Criar ----------
  test('o dono cria: token forte, uso único, 7 dias; o banco guarda só o hash', async () => {
    const res = await create(1);
    assert.equal(res.status, 201);
    assert.match(res.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.message, MSG.created);
    assert.equal(db.invites.length, 1);
    assert.equal(db.invites[0].token_hash, sha(res.body.token));
    assert.notEqual(db.invites[0].token_hash, res.body.token);
    assert.equal(JSON.stringify(db.invites).includes(res.body.token), false, 'o token não fica no banco');
    const other = await create(1, 100, 'rival');
    assert.notEqual(other.body.token, res.body.token);
  });

  test('um convite novo cancela o anterior da mesma missão', async () => {
    const first = await create(1);
    await create(1, 100, 'rival');
    assert.ok(db.invites[0].canceled_at);
    const res = await accept(2, first.body.token);
    assert.equal(res.status, 410);
  });

  test('negado: criar sem ser dono, em missão em par ou encerrada, tipo inválido, sem 18+ e sem login', async () => {
    assert.equal((await create(2, 100)).status, 404, 'missão de outra pessoa');
    assert.equal((await create(1, 999)).status, 404);
    assert.equal((await create(5, 300)).status, 409, 'missão já em par');
    assert.equal((await create(3, 500)).status, 409, 'missão encerrada');
    const kind = await create(1, 100, 'amigo');
    assert.equal(kind.status, 400);
    assert.equal(kind.body.error, MSG.kindInvalid);
    assert.equal((await create(4, 400)).status, 403, 'sem 18+');
    assert.equal((await call('POST', '/api/invites', null, { mission_id: 100, kind: 'duo' })).status, 401);
    assert.equal(db.invites.length, 0);
  });

  // ---------- Aceitar ----------
  test('Duo: quem aceita entra na missão do dono; início do par com NOW()', async () => {
    const { body } = await create(1);
    const res = await accept(2, body.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { accepted: true, kind: 'duo', mission_id: 100, message: MSG.acceptedDuo });
    assert.equal(mission(100).mode, 'parceiro');
    assert.equal(mission(100).partner_id, 2);
    assert.ok(mission(100).pair_started_at);
    assert.ok(db.queries.some((q) => /pair_started_at = NOW\(\)/.test(q.text)));
    assert.equal(db.invites[0].used_by, 2);
    assert.equal(consoleCalls.length, 0);
  });

  test('Rival: liga a própria missão Solo e forma o par (mission_matches com NOW())', async () => {
    const { body } = await create(1, 100, 'rival');
    const res = await accept(2, body.token, { mission_id: 200 });
    assert.equal(res.status, 200);
    assert.equal(res.body.mission_id, 200);
    assert.equal(res.body.message, MSG.acceptedRival);
    assert.deepEqual(db.matches.map((m) => [m.mission_a_id, m.mission_b_id, m.mode]), [[100, 200, 'rival']]);
    assert.equal(mission(100).partner_id, 2);
    assert.equal(mission(200).partner_id, 1);
    assert.equal(mission(100).mode, 'rival');
    assert.equal(mission(200).mode, 'rival');
  });

  test('Rival sem missão: cria uma com o mesmo desafio, sem os textos pessoais do dono', async () => {
    const { body } = await create(1, 100, 'rival');
    const res = await accept(7, body.token);
    assert.equal(res.status, 200);
    const mine = mission(res.body.mission_id);
    assert.equal(mine.user_id, 7);
    assert.equal(mine.title, 'Ler uma página');
    assert.equal(mine.category, 'estudo');
    assert.equal(mine.daily_minimum, 'Uma página');
    assert.equal(mine.why_it_matters, null);
    assert.equal(mine.fallback_plan, null);
    assert.equal(mine.mode, 'rival');
    assert.equal(mine.partner_id, 1);
  });

  test('negado: o próprio convite, usado, vencido, cancelado e inexistente', async () => {
    const { body } = await create(1);
    const own = await accept(1, body.token);
    assert.equal(own.status, 400);
    assert.equal(own.body.error, MSG.own);
    assert.equal((await accept(2, body.token)).status, 200);
    const used = await accept(7, body.token);
    assert.equal(used.status, 409);
    assert.equal(used.body.error, MSG.alreadyUsed);

    resetDb();
    const late = await create(1);
    db.invites[0].expires_at = new Date(Date.now() - 1000);
    const expired = await accept(2, late.body.token);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error, MSG.expired);

    resetDb();
    const gone = await create(1);
    assert.equal((await call('DELETE', `/api/invites/${gone.body.invite.id}`, 1)).status, 200);
    const canceled = await accept(2, gone.body.token);
    assert.equal(canceled.status, 410);
    assert.equal(canceled.body.error, MSG.wasCanceled);

    assert.equal((await accept(2, 'x'.repeat(43))).status, 404);
    assert.equal((await accept(2, 'curto')).status, 404);
    assert.equal(mission(100).partner_id, null, 'nada mudou');
  });

  test('negado: quem já está num par ativo não aceita', async () => {
    const { body } = await create(1);
    const res = await accept(5, body.token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, MSG.alreadyPaired);
    assert.equal(mission(100).partner_id, null);
    assert.equal(db.invites[0].used_at, null);
  });

  test('negado: entre quem se bloqueou não há aceite (e a resposta não diz por quê)', async () => {
    const { body } = await create(1);
    const res = await accept(6, body.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, MSG.blocked);
    db.blocks = [{ blocker_id: 2, blocked_id: 1 }];
    assert.equal((await accept(2, body.token)).status, 403, 'o bloqueio vale nos dois sentidos');
    assert.equal(db.invites[0].used_at, null);
  });

  test('negado: sem 18+, sem login, Rival com missão de outra pessoa ou missão do dono já em par', async () => {
    const { body } = await create(1, 100, 'rival');
    assert.equal((await accept(4, body.token)).status, 403);
    assert.equal((await call('POST', '/api/invites/accept', null, { token: body.token })).status, 401);
    assert.equal((await accept(2, body.token, { mission_id: 400 })).status, 400, 'missão de outra pessoa');
    assert.equal((await accept(2, body.token, { mission_id: 'abc' })).status, 400);
    mission(100).partner_id = 8;
    const taken = await accept(2, body.token, { mission_id: 200 });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, MSG.missionTaken);
    assert.equal(db.matches.length, 0);
  });

  test('negado: corrida de dois aceites ao mesmo tempo, só um passa', async () => {
    const { body } = await create(1);
    db.slow = 3;
    const results = await Promise.all([accept(2, body.token), accept(7, body.token)]);
    const ok = results.filter((r) => r.status === 200);
    const no = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(no.length, 1);
    assert.ok([2, 7].includes(mission(100).partner_id));
    assert.equal(db.invites[0].used_by, mission(100).partner_id);
  });

  test('negado: criar um convite novo e aceitar o antigo ao mesmo tempo não dá deadlock nem 500', async () => {
    // Várias defasagens: o aceite sai antes e a criação entra no meio dele.
    for (const atraso of [0, 2, 4, 6, 8, 10, 12]) {
      resetDb();
      const { body } = await create(1);
      db.slow = 3;
      const aceitePromessa = accept(2, body.token);
      await new Promise((resolve) => setTimeout(resolve, atraso));
      const [novo, aceite] = await Promise.all([create(1, 100, 'rival'), aceitePromessa]);
      db.slow = 0;
      assert.notEqual(novo.status, 500, `criar: ${JSON.stringify(novo.body)}`);
      assert.notEqual(aceite.status, 500, `aceitar: ${JSON.stringify(aceite.body)}`);
      // Um dos dois chega primeiro; o estado final é coerente.
      if (aceite.status === 200) {
        assert.equal(novo.status, 409, 'a missão virou Duo: não dá mais para convidar');
        assert.equal(mission(100).partner_id, 2);
      } else {
        assert.equal(aceite.status, 410, 'o convite antigo foi cancelado pelo novo');
        assert.equal(novo.status, 201);
        assert.equal(mission(100).partner_id, null);
      }
    }
  });

  // ---------- Ver e cancelar ----------
  test('ver o convite: tipo, apelido do dono e o desafio; negados vencido e sem login', async () => {
    const { body } = await create(1, 100, 'rival');
    const res = await call('POST', '/api/invites/preview', 2, { token: body.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.invite.kind, 'rival');
    assert.equal(res.body.invite.owner_name, 'dono');
    assert.equal(res.body.invite.title, 'Ler uma página');
    assert.equal(JSON.stringify(res.body).includes('motivo pessoal'), false, 'sem os textos pessoais do dono');
    db.invites[0].expires_at = new Date(Date.now() - 1);
    assert.equal((await call('POST', '/api/invites/preview', 2, { token: body.token })).status, 410);
    assert.equal((await call('POST', '/api/invites/preview', null, { token: body.token })).status, 401);
  });

  test('cancelar: só o dono; convite usado não cancela', async () => {
    const { body } = await create(1);
    assert.equal((await call('DELETE', `/api/invites/${body.invite.id}`, 2)).status, 404, 'não é o dono');
    assert.equal(db.invites[0].canceled_at, null);
    assert.equal((await accept(2, body.token)).status, 200);
    const used = await call('DELETE', `/api/invites/${body.invite.id}`, 1);
    assert.equal(used.status, 409);
    assert.equal((await call('DELETE', `/api/invites/${body.invite.id}`)).status, 401);
  });

  // ---------- Sem pareamento automático e antes da 012 ----------
  test('funciona com o MATCHING_ENABLED desligado e não chama o pareamento automático', async () => {
    assert.equal(process.env.MATCHING_ENABLED, 'false');
    const { body } = await create(1, 100, 'rival');
    assert.equal((await accept(2, body.token, { mission_id: 200 })).status, 200);
    assert.equal(db.queries.some((q) => /m\.match_preference = \$1/.test(q.text)), false);
    const missions = fs.readFileSync(path.join(__dirname, '..', 'routes', 'missions.js'), 'utf8');
    assert.match(missions, /if \(!isMatchingEnabled\(\)\) \{\s*return res\.json\(\{ matched: false, matchingEnabled: false, mission \}\);/);
  });

  test('antes da 012: 503 calmo e nada muda', async () => {
    db.migrated012 = false;
    for (const res of [
      await create(1),
      await accept(2, 'a'.repeat(43)),
      await call('POST', '/api/invites/preview', 2, { token: 'a'.repeat(43) }),
      await call('DELETE', '/api/invites/1', 1)
    ]) {
      assert.equal(res.status, 503);
      assert.equal(res.body.error, MSG.unavailable);
    }
    assert.equal(mission(100).partner_id, null);
    assert.equal(consoleCalls.length, 0);
  });

  test('antes da 011 (sem a tabela de bloqueios), o aceite segue', async () => {
    db.migrated011 = false;
    const { body } = await create(1);
    assert.equal((await accept(2, body.token)).status, 200);
  });

  test('o token nunca vai na URL nem para o log', async () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'invites.js'), 'utf8');
    assert.doesNotMatch(routes, /router\.(get|post)\('\/:token/);
    const { body } = await create(1);
    await accept(2, body.token);
    assert.equal(consoleCalls.length, 0);
  });
});

describe('migração 012 e exclusão de conta', () => {
  test('012: só acrescenta, registra a versão e explica a volta', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '012_mission_invites.sql'), 'utf8');
    const code = sql.replace(/--.*$/gm, '').replace(/ON DELETE (CASCADE|SET NULL)/g, '');
    assert.doesNotMatch(code, /\b(DROP|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
    assert.match(code, /CREATE TABLE IF NOT EXISTS mission_invites/);
    assert.match(code, /token_hash CHAR\(64\) NOT NULL UNIQUE/);
    assert.doesNotMatch(code, /\btoken\s+(TEXT|VARCHAR)/i, 'o token em si não é coluna');
    assert.match(code, /'012_mission_invites'/);
    assert.match(sql, /Para voltar atrás/);
    assert.match(sql, /NÃO APLICAR/);
  });

  test('os convites saem com a conta (passo opcional antes da 012)', () => {
    const step = ACCOUNT_DELETION_STEPS.find((s) => s.name === 'convites_de_missao');
    assert.ok(step);
    assert.equal(step.optional, true);
    const sql = normalize(step.sql);
    assert.match(sql, /created_by = \$1/);
    assert.match(sql, /used_by = \$1/);
    const names = ACCOUNT_DELETION_STEPS.map((s) => s.name);
    assert.ok(names.indexOf('convites_de_missao') < names.indexOf('missoes'));
  });
});
