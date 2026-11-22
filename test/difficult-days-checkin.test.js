const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');
const { NOTE_CONSENT_SQL, consentRows } = require('./helpers/note-consent-db');
const {
  DIFFICULT_CONSECUTIVE_MESSAGE,
  DIFFICULT_LIMIT_MESSAGE,
  DIFFICULT_MINIMUM_MESSAGE
} = require('../lib/difficult-days');
const {
  getLegacyMissionDayNumber,
  getMissionDayNumber
} = require('../lib/reminder-schedule');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const checkinsRouter = require('../routes/checkins');

const app = express();
app.use(express.json());
app.use('/api/checkins', checkinsRouter);

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function checkinKey(row) {
  return `${Number(row.mission_id)}:${Number(row.user_id)}:${Number(row.day_number)}`;
}

function createSimulator() {
  const state = {
    users: new Map(),
    missions: new Map(),
    checkins: [],
    locks: new Map(),
    nextId: 1,
    txSeq: 0,
    connects: 0,
    trace: [],
    hooks: {}
  };

  function missionView(tx, id) {
    const base = state.missions.get(Number(id));
    if (!base) return null;
    const patch = tx && tx.missions.get(Number(id));
    return patch ? { ...base, ...patch } : { ...base };
  }

  function readCheckins(tx) {
    const map = new Map(state.checkins.map(row => [checkinKey(row), { ...row }]));
    if (tx) {
      for (const [key, row] of tx.checkins) map.set(key, { ...row });
    }
    return [...map.values()];
  }

  function createTx() {
    state.txSeq += 1;
    return {
      id: state.txSeq,
      checkins: new Map(),
      missions: new Map(),
      held: new Set(),
      open: true
    };
  }

  async function acquire(key, tx) {
    if (!tx) return;
    const lock = state.locks.get(key);
    if (!lock) {
      state.locks.set(key, { owner: tx, queue: [] });
      tx.held.add(key);
      if (String(key).startsWith('mission:') && state.hooks.afterLockAcquired) {
        await state.hooks.afterLockAcquired(tx, key);
      }
      return;
    }
    if (lock.owner === tx) return;
    await new Promise(resolve => {
      lock.queue.push({ tx, resolve });
      if (state.hooks.onLockWait) state.hooks.onLockWait(tx, key);
    });
    tx.held.add(key);
    if (String(key).startsWith('mission:') && state.hooks.afterLockAcquired) {
      await state.hooks.afterLockAcquired(tx, key);
    }
  }

  function releaseLocks(tx) {
    if (!tx) return;
    for (const key of [...tx.held]) {
      const lock = state.locks.get(key);
      if (!lock || lock.owner !== tx) continue;
      const next = lock.queue.shift();
      if (next) {
        lock.owner = next.tx;
        next.resolve();
      } else {
        state.locks.delete(key);
      }
    }
    tx.held.clear();
  }

  function commit(tx) {
    if (!tx || !tx.open) return;
    for (const [key, row] of tx.checkins) {
      const index = state.checkins.findIndex(item => checkinKey(item) === key);
      if (index >= 0) state.checkins[index] = { ...row };
      else state.checkins.push({ ...row });
    }
    for (const [id, patch] of tx.missions) {
      const mission = state.missions.get(id);
      if (mission) Object.assign(mission, patch);
    }
    tx.open = false;
    releaseLocks(tx);
    if (state.hooks.onCommit) state.hooks.onCommit(tx);
  }

  function rollback(tx) {
    if (!tx || !tx.open) return;
    tx.open = false;
    tx.checkins.clear();
    tx.missions.clear();
    releaseLocks(tx);
    if (state.hooks.onRollback) state.hooks.onRollback(tx);
  }

  function lockKeys(text, params) {
    if (/FROM users/i.test(text)) return [`user:${Number(params[0])}`];
    if (/FROM missions/i.test(text)) return [`mission:${Number(params[0])}`];
    if (/FROM checkins/i.test(text)) return [`checkins:${Number(params[0])}:${Number(params[1])}`];
    return [`sql:${text}`];
  }

  function storeCheckin(tx, row) {
    const key = checkinKey(row);
    if (tx) tx.checkins.set(key, row);
    else {
      const index = state.checkins.findIndex(item => checkinKey(item) === key);
      if (index >= 0) state.checkins[index] = row;
      else state.checkins.push(row);
    }
  }

  function patchMission(tx, id, patch) {
    const mission = missionView(tx, id);
    if (!mission) return;
    if (tx) tx.missions.set(Number(id), { ...(tx.missions.get(Number(id)) || {}), ...patch });
    else Object.assign(state.missions.get(Number(id)), patch);
  }

  async function query(sql, params = [], tx = null) {
    const text = normalize(sql);
    state.trace.push({ tx: tx ? tx.id : null, text });

    if (text === 'BEGIN') return { rows: [], rowCount: 0 };
    if (text === 'COMMIT') {
      commit(tx);
      return { rows: [], rowCount: 0 };
    }
    if (text === 'ROLLBACK') {
      rollback(tx);
      return { rows: [], rowCount: 0 };
    }

    if (/FOR UPDATE/i.test(text)) {
      for (const key of lockKeys(text, params)) await acquire(key, tx);
    }

    if (/^UPDATE missions SET (user_score|partner_score)/i.test(text)) {
      const field = /user_score/i.test(text) ? 'user_score' : 'partner_score';
      const mission = missionView(tx, params[0]);
      patchMission(tx, params[0], { [field]: Number(mission[field] || 0) + 1 });
      return { rows: [], rowCount: 1 };
    }

    if (/^UPDATE missions SET status = 'completed'/i.test(text)) {
      patchMission(tx, params[0], { status: 'completed' });
      return { rows: [], rowCount: 1 };
    }

    if (/^INSERT INTO checkins/i.test(text)) {
      const wantsDifficult = params[4] === true;
      const incoming = {
        id: state.nextId,
        mission_id: Number(params[0]),
        user_id: Number(params[1]),
        day_number: Number(params[2]),
        completed: true,
        note: params[3] || null,
        is_difficult: wantsDifficult,
        created_at: new Date().toISOString()
      };
      const existing = readCheckins(tx).find(row => checkinKey(row) === checkinKey(incoming));
      const saved = existing
        ? {
          ...existing,
          completed: true,
          // Igual ao SQL: CASE WHEN $6 THEN NULL ELSE COALESCE($4, checkins.note) END
          note: params[5] === true ? null : (incoming.note ?? existing.note ?? null),
          is_difficult: existing.is_difficult === true || wantsDifficult
        }
        : incoming;
      if (!existing) state.nextId += 1;
      storeCheckin(tx, saved);
      return { rows: [{ ...saved }], rowCount: 1 };
    }

    if (!/^SELECT/i.test(text)) return { rows: [], rowCount: 0 };

    if (NOTE_CONSENT_SQL.test(text)) return consentRows(true);
    if (/FROM users/i.test(text) && /reminder_time/i.test(text)) {
      const user = state.users.get(Number(params[0]));
      if (!user) return { rows: [], rowCount: 0 };
      return {
        rows: [{ reminder_time: user.reminder_time, timezone: user.timezone }],
        rowCount: 1
      };
    }

    if (/FROM mission_matches/i.test(text)) return { rows: [], rowCount: 0 };

    if (/FROM missions/i.test(text)) {
      if (/FOR UPDATE/i.test(text)) {
        const mission = missionView(tx, params[0]);
        return { rows: mission ? [mission] : [], rowCount: mission ? 1 : 0 };
      }

      const filtersMember = /user_id/i.test(text) && /partner_id/i.test(text) && params.length >= 2;
      if (filtersMember) {
        const mission = missionView(tx, params[0]);
        if (!mission) return { rows: [], rowCount: 0 };
        const requester = Number(params[1]);
        const allowed = Number(mission.user_id) === requester
          || (mission.partner_id != null && Number(mission.partner_id) === requester);
        return { rows: allowed ? [mission] : [], rowCount: allowed ? 1 : 0 };
      }

      const mission = missionView(tx, params[0]);
      return { rows: mission ? [mission] : [], rowCount: mission ? 1 : 0 };
    }

    if (/FROM checkins/i.test(text)) {
      let rows = readCheckins(tx).filter(row => Number(row.mission_id) === Number(params[0]));
      if (/user_id = \$2/i.test(text)) {
        rows = rows.filter(row => Number(row.user_id) === Number(params[1]));
      }
      if (/is_difficult = true/i.test(text)) {
        rows = rows.filter(row => row.is_difficult === true);
      }
      if (/day_number = \$3/i.test(text)) {
        rows = rows.filter(row => Number(row.day_number) === Number(params[2]));
      }
      if (/day_number >= \$3/i.test(text)) {
        rows = rows.filter(row => Number(row.day_number) >= Number(params[2]));
      }
      if (/day_number >= \$2/i.test(text)) {
        rows = rows.filter(row => Number(row.day_number) >= Number(params[1]));
      }
      if (/completed = true/i.test(text)) {
        rows = rows.filter(row => row.completed === true);
      }
      if (/ANY\(\$1/i.test(text)) {
        const ids = new Set((params[0] || []).map(Number));
        rows = readCheckins(tx).filter(row => ids.has(Number(row.mission_id)));
      }

      if (/is_difficult = true/i.test(text) && tx && state.hooks.afterDifficultRead) {
        await state.hooks.afterDifficultRead(tx, rows);
      }

      if (/username/i.test(text)) {
        rows = rows.map(row => ({
          ...row,
          username: state.users.get(Number(row.user_id))?.username || 'pessoa'
        }));
      }

      return {
        rows: rows.map(row => ({ ...row })),
        rowCount: rows.length
      };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    state,
    reset() {
      state.users.clear();
      state.missions.clear();
      state.checkins = [];
      state.locks.clear();
      state.nextId = 1;
      state.connects = 0;
      state.trace = [];
      state.hooks.onLockWait = null;
      state.hooks.onCommit = null;
      state.hooks.onRollback = null;
      state.hooks.afterDifficultRead = null;
      state.hooks.afterLockAcquired = null;
    },
    connect() {
      state.connects += 1;
      const tx = createTx();
      return {
        query: (sql, params) => query(sql, params, tx),
        release: () => rollback(tx)
      };
    },
    query: (sql, params) => query(sql, params, null)
  };
}

const simulator = createSimulator();

function user(id, extra = {}) {
  return {
    id,
    username: `pessoa${id}`,
    reminder_time: null,
    timezone: null,
    ...extra
  };
}

function mission(extra = {}) {
  return {
    id: 10,
    user_id: 1,
    partner_id: 2,
    user_name: 'pessoa1',
    partner_name: 'pessoa2',
    status: 'active',
    mode: 'parceiro',
    proof_mode: 'self_report',
    started_at: new Date().toISOString(),
    duration_days: 30,
    user_score: 0,
    partner_score: 0,
    title: 'constancia',
    ...extra
  };
}

function putUser(row) {
  simulator.state.users.set(row.id, row);
}

function putMission(row) {
  simulator.state.missions.set(row.id, row);
}

function seedCheckin(row) {
  simulator.state.checkins.push({
    id: simulator.state.nextId,
    completed: true,
    note: null,
    is_difficult: false,
    created_at: new Date().toISOString(),
    ...row
  });
  simulator.state.nextId += 1;
}

function startedForLegacyDay(dayNumber) {
  const elapsed = (dayNumber - 1) * 24 * 60 * 60 * 1000 + 60 * 1000;
  return new Date(Date.now() - elapsed).toISOString();
}

function difficultDays(missionId, userId) {
  return simulator.state.checkins
    .filter(row => row.mission_id === missionId && row.user_id === userId && row.is_difficult === true)
    .map(row => row.day_number)
    .sort((left, right) => left - right);
}

function findZonedStart(zone) {
  const now = Date.now();
  for (let offsetHours = 1; offsetHours <= 24 * 25; offsetHours += 1) {
    const started = new Date(now - offsetHours * 60 * 60 * 1000).toISOString();
    const later = new Date(now + 2 * 60 * 1000);
    const zoned = getMissionDayNumber(started, new Date(now), zone);
    const legacy = getLegacyMissionDayNumber(started, new Date(now));
    const zonedLater = getMissionDayNumber(started, later, zone);
    const legacyLater = getLegacyMissionDayNumber(started, later);
    const open = [zoned, legacy].every(day => Number.isInteger(day) && day >= 1 && day <= 28);
    if (open && zoned !== legacy && zonedLater === zoned && legacyLater === legacy) {
      return { started, zoned, legacy };
    }
  }
  return null;
}

let server;
let baseUrl;

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

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

function armRace() {
  const timeline = [];
  let reads = 0;
  let releaseFirst;
  const secondBlocked = new Promise(resolve => {
    releaseFirst = resolve;
  });

  simulator.state.hooks.afterDifficultRead = async () => {
    reads += 1;
    timeline.push(`read${reads}`);
    if (reads === 1) {
      const waited = await Promise.race([
        secondBlocked.then(() => 'blocked'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 1500))
      ]);
      assert.equal(waited, 'blocked', 'o segundo pedido tem de esperar a trava');
    }
  };
  simulator.state.hooks.onLockWait = () => releaseFirst();
  simulator.state.hooks.onCommit = () => timeline.push('commit');
  simulator.state.hooks.onRollback = () => timeline.push('rollback');
  return timeline;
}

function armLockRace() {
  const timeline = [];
  let missionLocks = 0;
  let releaseFirst;
  const secondBlocked = new Promise(resolve => {
    releaseFirst = resolve;
  });

  simulator.state.hooks.afterLockAcquired = async (tx, key) => {
    if (!String(key).startsWith('mission:')) return;
    missionLocks += 1;
    timeline.push(`lock${missionLocks}`);
    if (missionLocks === 1) {
      const waited = await Promise.race([
        secondBlocked.then(() => 'blocked'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 1500))
      ]);
      assert.equal(waited, 'blocked', 'o outro pedido tem de esperar a trava da missão');
    }
  };
  simulator.state.hooks.onLockWait = (tx, key) => {
    if (!String(key).startsWith('mission:')) return;
    timeline.push('wait');
    releaseFirst();
  };
  simulator.state.hooks.onCommit = () => timeline.push('commit');
  return timeline;
}

describe('dias difíceis no check-in', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb((sql, params) => simulator.query(sql, params)));
    mock.method(Pool.prototype, 'connect', () => simulator.connect());
    await new Promise(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('quem não participa recebe 404 no placar, igual a missão inexistente', async () => {
    simulator.reset();
    putUser(user(1));
    putUser(user(2));
    putUser(user(8));
    putMission(mission());
    seedCheckin({ mission_id: 10, user_id: 8, day_number: 1, is_difficult: true, minimum_done: true });

    const denied = await request('GET', '/api/checkins/10/score', { token: tokenFor(8) });
    const missing = await request('GET', '/api/checkins/999/score', { token: tokenFor(8) });
    const streak = await request('GET', '/api/checkins/10/streak', { token: tokenFor(8) });
    const progress = await request('GET', '/api/checkins/10', { token: tokenFor(8) });

    assert.equal(denied.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(streak.status, 404);
    assert.equal(progress.status, 404);
    assert.deepEqual(denied.body, missing.body);
    assert.deepEqual(denied.body, { error: 'Missão não encontrada.' });
  });

  test('ex-parceiro não grava check-in comum nem dia difícil', async () => {
    simulator.reset();
    putUser(user(1));
    putUser(user(9));
    putMission(mission({
      id: 12,
      partner_id: null,
      partner_name: null,
      mode: 'solo'
    }));
    seedCheckin({ mission_id: 12, user_id: 9, day_number: 1 });

    const plain = await request('POST', '/api/checkins', {
      token: tokenFor(9),
      body: { mission_id: 12 }
    });
    const difficult = await request('POST', '/api/checkins', {
      token: tokenFor(9),
      body: { mission_id: 12, difficult: true, minimum_done: true }
    });

    assert.equal(plain.status, 404);
    assert.equal(difficult.status, 404);
    assert.deepEqual(plain.body, { error: 'Missão não encontrada.' });
    assert.deepEqual(difficult.body, plain.body);
    assert.equal(simulator.state.checkins.length, 1);
    assert.equal(simulator.state.connects, 0);
  });

  test('dia difícil conta como feito, no máximo 4 por pessoa e no máximo 2 seguidos', async () => {
    simulator.reset();
    putUser(user(1));
    putUser(user(2));
    const today = 9;
    putMission(mission({ started_at: startedForLegacyDay(today) }));
    for (const day of [1, 3, 5, 7]) {
      seedCheckin({ mission_id: 10, user_id: 2, day_number: day, is_difficult: true, minimum_done: true });
    }

    const own = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 10, difficult: true, minimum_done: true }
    });
    assert.equal(own.status, 201);
    assert.equal(own.body.day, today);
    assert.equal(own.body.checkin.completed, true);
    assert.equal(own.body.checkin.is_difficult, true);
    assert.equal(own.body.checkin.difficult, true);
    assert.equal(own.body.already_done, false);

    const repeated = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 10, difficult: true, minimum_done: true }
    });
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.already_done, true);
    assert.equal(repeated.body.checkin.is_difficult, true);
    assert.deepEqual(difficultDays(10, 1), [today]);

    const streak = await request('GET', '/api/checkins/10/streak', { token: tokenFor(1) });
    assert.equal(streak.status, 200);
    assert.deepEqual(streak.body.difficult_days, [today]);
    assert.equal(streak.body.difficult_days_used, 1);
    assert.equal(streak.body.difficult_days_remaining, 3);
    assert.equal(streak.body.today_done, true);

    const listed = await request('GET', '/api/checkins/10', { token: tokenFor(1) });
    const mine = listed.body.progress['1'].checkins;
    assert.deepEqual(mine.map(item => item.difficult), [true]);

    simulator.reset();
    putUser(user(1));
    putMission(mission({ id: 20, partner_id: null, partner_name: null, mode: 'solo', started_at: startedForLegacyDay(3) }));
    seedCheckin({ mission_id: 20, user_id: 1, day_number: 1, is_difficult: true, minimum_done: true });
    seedCheckin({ mission_id: 20, user_id: 1, day_number: 2, is_difficult: true, minimum_done: true });
    const third = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 20, difficult: true, minimum_done: true }
    });
    assert.equal(third.status, 400);
    assert.equal(third.body.error, DIFFICULT_CONSECUTIVE_MESSAGE);
    assert.equal(simulator.state.checkins.some(row => row.day_number === 3), false);

    simulator.reset();
    putUser(user(1));
    putMission(mission({ id: 21, partner_id: null, partner_name: null, mode: 'solo', started_at: startedForLegacyDay(4) }));
    seedCheckin({ mission_id: 21, user_id: 1, day_number: 1, is_difficult: true, minimum_done: true });
    seedCheckin({ mission_id: 21, user_id: 1, day_number: 2, is_difficult: true, minimum_done: true });
    seedCheckin({ mission_id: 21, user_id: 1, day_number: 3, is_difficult: false });
    const afterGap = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 21, difficult: true, minimum_done: true }
    });
    assert.equal(afterGap.status, 201);
    assert.deepEqual(difficultDays(21, 1), [1, 2, 4]);

    simulator.reset();
    putUser(user(1));
    putMission(mission({ id: 22, partner_id: null, partner_name: null, mode: 'solo', started_at: startedForLegacyDay(9) }));
    for (const day of [1, 3, 5, 7]) {
      seedCheckin({ mission_id: 22, user_id: 1, day_number: day, is_difficult: true, minimum_done: true });
    }
    const full = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 22, difficult: true, minimum_done: true }
    });
    assert.equal(full.status, 400);
    assert.equal(full.body.error, DIFFICULT_LIMIT_MESSAGE);
    assert.equal(simulator.state.checkins.some(row => row.day_number === 9), false);

    const asText = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 22, difficult: 'true' }
    });
    assert.equal(asText.status, 201);
    assert.equal(asText.body.checkin.is_difficult, false);
    assert.equal(asText.body.checkin.difficult, false);
  });

  test('dia difícil sem confirmar o mínimo não é gravado (400, mensagem calma)', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 30,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      proof_mode: 'workout_proof',
      started_at: startedForLegacyDay(1)
    }));

    for (const body of [
      { mission_id: 30, difficult: true },
      { mission_id: 30, difficult: true, minimum_done: false },
      { mission_id: 30, difficult: true, minimum_done: 'true' },
      { mission_id: 30, difficult: true, note: 'uma frase longa o bastante' }
    ]) {
      const res = await request('POST', '/api/checkins', { token: tokenFor(1), body });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, DIFFICULT_MINIMUM_MESSAGE);
    }
    assert.equal(simulator.state.checkins.length, 0);
    assert.equal(simulator.state.connects, 0);
  });

  test('dia difícil com o mínimo confirmado não exige a frase do contrato', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 30,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      proof_mode: 'workout_proof',
      started_at: startedForLegacyDay(1)
    }));

    const res = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 30, difficult: true, minimum_done: true }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.checkin.completed, true);
    assert.equal(res.body.checkin.is_difficult, true);
    assert.equal(res.body.checkin.note, null);
    assert.equal(simulator.state.missions.get(30).user_score, 1);
  });

  test('dia difícil com frase curta opcional é aceito e a frase é gravada', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 32,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      proof_mode: 'study_note',
      started_at: startedForLegacyDay(1)
    }));

    const res = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 32, difficult: true, minimum_done: true, note: 'li 1 pág' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.checkin.is_difficult, true);
    assert.equal(simulator.state.checkins[0].note, 'li 1 pág');
  });

  test('check-in comum continua a exigir a prova do contrato, mesmo com minimum_done', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 33,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      proof_mode: 'workout_proof',
      started_at: startedForLegacyDay(1)
    }));

    const short = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 33, minimum_done: true, note: 'curta' }
    });
    assert.equal(short.status, 400);
    assert.equal(short.body.error, 'Esta missao exige uma prova curta antes do check-in.');
    assert.equal(simulator.state.checkins.length, 0);

    const enough = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 33, note: 'prova curta' }
    });
    assert.equal(enough.status, 201);
    assert.equal(enough.body.checkin.is_difficult, false);
  });

  test('caso negado: sem login o dia difícil não é gravado', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({ id: 34, started_at: startedForLegacyDay(1) }));

    const res = await request('POST', '/api/checkins', {
      body: { mission_id: 34, difficult: true, minimum_done: true }
    });
    assert.equal(res.status, 401);
    assert.equal(simulator.state.checkins.length, 0);
    assert.equal(simulator.state.connects, 0);
  });

  test('caso negado: outra pessoa recebe 404 no dia difícil, com ou sem minimum_done', async () => {
    simulator.reset();
    putUser(user(1));
    putUser(user(2));
    putUser(user(7));
    putMission(mission({ id: 35, started_at: startedForLegacyDay(1) }));

    for (const body of [
      { mission_id: 35, difficult: true, minimum_done: true },
      { mission_id: 35, difficult: true }
    ]) {
      const res = await request('POST', '/api/checkins', { token: tokenFor(7), body });
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: 'Missão não encontrada.' });
    }
    assert.equal(simulator.state.checkins.length, 0);
  });

  test('dia difícil sem frase não apaga a nota que já existia no dia', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 36,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(1)
    }));

    const plain = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 36, note: 'li duas páginas' }
    });
    const difficult = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 36, difficult: true, minimum_done: true, note: '' }
    });

    assert.equal(plain.status, 201);
    assert.equal(difficult.status, 201);
    assert.equal(simulator.state.checkins.length, 1);
    assert.equal(simulator.state.checkins[0].note, 'li duas páginas');
    assert.equal(simulator.state.checkins[0].is_difficult, true);
    const upsert = simulator.state.trace.find(item => /^INSERT INTO checkins/i.test(item.text));
    assert.match(upsert.text, /note = CASE WHEN \$6 THEN NULL ELSE COALESCE\(\$4, checkins\.note\) END/);
  });

  test('crise ao repetir o dia apaga a nota anterior e não grava a nova', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 37,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(1)
    }));

    await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 37, note: 'li duas páginas' }
    });
    const crisis = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 37, difficult: true, minimum_done: true, note: 'hoje eu so quero morrer' }
    });

    assert.equal(crisis.status, 201);
    assert.equal(crisis.body.crisis, true);
    assert.equal(crisis.body.checkin.note, null);
    assert.equal(simulator.state.checkins.length, 1);
    assert.equal(simulator.state.checkins[0].note, null);
    assert.equal(simulator.state.checkins[0].is_difficult, true);
  });

  test('frase nova sem crise substitui a nota do dia', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 38,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(1)
    }));

    await request('POST', '/api/checkins', { token: tokenFor(1), body: { mission_id: 38, note: 'primeira' } });
    await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 38, difficult: true, minimum_done: true, note: 'segunda frase' }
    });
    assert.equal(simulator.state.checkins[0].note, 'segunda frase');
  });

  test('repetir o dia sem a marca difícil não apaga a marca', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 31,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(1)
    }));

    const marked = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 31, difficult: true, minimum_done: true }
    });
    const plain = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 31 }
    });

    assert.equal(marked.status, 201);
    assert.equal(plain.status, 201);
    assert.equal(plain.body.already_done, true);
    assert.equal(simulator.state.checkins[0].is_difficult, true);
    assert.deepEqual(difficultDays(31, 1), [1]);
  });

  test('dois pedidos difíceis ao mesmo tempo não passam de 4 nem dobram o ponto', async () => {
    simulator.reset();
    putUser(user(1));
    const today = 7;
    putMission(mission({
      id: 40,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(today)
    }));
    for (const day of [1, 3, 5]) {
      seedCheckin({ mission_id: 40, user_id: 1, day_number: day, is_difficult: true, minimum_done: true });
    }
    const timeline = armRace();

    const [first, second] = await Promise.all([
      request('POST', '/api/checkins', {
        token: tokenFor(1),
        body: { mission_id: 40, difficult: true, minimum_done: true }
      }),
      request('POST', '/api/checkins', {
        token: tokenFor(1),
        body: { mission_id: 40, difficult: true, minimum_done: true }
      })
    ]);

    assert.deepEqual([first.status, second.status], [201, 201]);
    const bodies = [first.body, second.body];
    assert.equal(bodies.filter(body => body.already_done === false).length, 1);
    assert.equal(bodies.filter(body => body.already_done === true).length, 1);
    assert.deepEqual(difficultDays(40, 1), [1, 3, 5, today]);
    assert.equal(simulator.state.checkins.filter(row => row.day_number === today).length, 1);
    assert.equal(simulator.state.missions.get(40).user_score, 1);
    assert.deepEqual(timeline.slice(0, 3), ['read1', 'commit', 'read2']);
  });

  test('dois pedidos seguidos ao mesmo tempo não gravam o terceiro dia difícil', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 41,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(3)
    }));
    seedCheckin({ mission_id: 41, user_id: 1, day_number: 1, is_difficult: true, minimum_done: true });
    seedCheckin({ mission_id: 41, user_id: 1, day_number: 2, is_difficult: true, minimum_done: true });
    const timeline = armRace();

    const [first, second] = await Promise.all([
      request('POST', '/api/checkins', {
        token: tokenFor(1),
        body: { mission_id: 41, difficult: true, minimum_done: true }
      }),
      request('POST', '/api/checkins', {
        token: tokenFor(1),
        body: { mission_id: 41, difficult: true, minimum_done: true }
      })
    ]);

    assert.equal(first.status, 400);
    assert.equal(second.status, 400);
    assert.equal(first.body.error, DIFFICULT_CONSECUTIVE_MESSAGE);
    assert.equal(second.body.error, DIFFICULT_CONSECUTIVE_MESSAGE);
    assert.deepEqual(difficultDays(41, 1), [1, 2]);
    assert.equal(simulator.state.missions.get(41).user_score, 0);
    assert.deepEqual(timeline.slice(0, 3), ['read1', 'rollback', 'read2']);
  });

  test('os dias 5 e 7 difíceis bloqueiam o 6, e o dia é calculado depois da trava', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 43,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(6)
    }));
    seedCheckin({ mission_id: 43, user_id: 1, day_number: 5, is_difficult: true, minimum_done: true });
    seedCheckin({ mission_id: 43, user_id: 1, day_number: 7, is_difficult: true, minimum_done: true });

    const blocked = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 43, difficult: true, minimum_done: true }
    });

    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, DIFFICULT_CONSECUTIVE_MESSAGE);
    assert.equal(blocked.body.day, undefined);
    assert.deepEqual(difficultDays(43, 1), [5, 7]);
    assert.equal(simulator.state.checkins.some(row => row.day_number === 6), false);

    const trace = simulator.state.trace.filter(entry => entry.tx != null).map(entry => entry.text);
    const missionLock = trace.findIndex(text => /FOR UPDATE/i.test(text) && /FROM missions/i.test(text));
    const clock = trace.findIndex(text => /reminder_time/i.test(text));
    const counted = trace.findIndex(text => /is_difficult = true/i.test(text));
    assert.ok(missionLock >= 0 && clock > missionLock && counted > clock);
  });

  test('um check-in comum e um difícil ao mesmo tempo não dobram o ponto', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 42,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(1)
    }));
    const timeline = armLockRace();

    const [plain, difficult] = await Promise.all([
      request('POST', '/api/checkins', {
        token: tokenFor(1),
        body: { mission_id: 42 }
      }),
      request('POST', '/api/checkins', {
        token: tokenFor(1),
        body: { mission_id: 42, difficult: true, minimum_done: true }
      })
    ]);

    assert.equal(plain.status, 201);
    assert.equal(difficult.status, 201);
    const bodies = [plain.body, difficult.body];
    assert.equal(bodies.filter(body => body.already_done === false).length, 1);
    assert.equal(bodies.filter(body => body.already_done === true).length, 1);
    assert.equal(simulator.state.checkins.filter(row => row.mission_id === 42).length, 1);
    assert.equal(simulator.state.checkins[0].is_difficult, true);
    assert.equal(simulator.state.checkins[0].completed, true);
    assert.equal(simulator.state.missions.get(42).user_score, 1);
    assert.deepEqual(timeline.slice(0, 4), ['lock1', 'wait', 'commit', 'lock2']);
  });

  test('perto da meia-noite o dia do check-in segue o fuso da pessoa', async () => {
    const split = findZonedStart('America/Sao_Paulo');
    assert.ok(split, 'não achei um horário estável em que o fuso e o relógio do servidor divergem');

    simulator.reset();
    putUser(user(1, { reminder_time: '08:00', timezone: 'America/Sao_Paulo' }));
    putUser(user(3));
    putUser(user(4, { reminder_time: '08:00', timezone: null }));
    putMission(mission({
      id: 50,
      user_id: 1,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: split.started
    }));
    putMission(mission({
      id: 51,
      user_id: 3,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      user_name: 'pessoa3',
      started_at: split.started
    }));
    putMission(mission({
      id: 52,
      user_id: 4,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      user_name: 'pessoa4',
      started_at: split.started
    }));

    const zoned = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 50 }
    });
    const emptyZone = await request('POST', '/api/checkins', {
      token: tokenFor(3),
      body: { mission_id: 51 }
    });
    const clockWithoutZone = await request('POST', '/api/checkins', {
      token: tokenFor(4),
      body: { mission_id: 52 }
    });

    assert.equal(zoned.status, 201);
    assert.equal(zoned.body.day, split.zoned);
    assert.notEqual(zoned.body.day, split.legacy);
    assert.equal(emptyZone.status, 201);
    assert.equal(emptyZone.body.day, split.legacy);
    assert.equal(clockWithoutZone.status, 201);
    assert.equal(clockWithoutZone.body.day, split.legacy);

    const zonedStreak = await request('GET', '/api/checkins/50/streak', { token: tokenFor(1) });
    const legacyStreak = await request('GET', '/api/checkins/51/streak', { token: tokenFor(3) });
    assert.equal(zonedStreak.body.today_done, true);
    assert.equal(legacyStreak.body.today_done, true);
    assert.equal(zonedStreak.body.difficult_days_used, 0);
    assert.equal(legacyStreak.body.difficult_days_remaining, 4);
  });

  test('a sequência conta os dias anteriores sem incluir hoje', async () => {
    simulator.reset();
    putUser(user(1));
    putMission(mission({
      id: 60,
      partner_id: null,
      partner_name: null,
      mode: 'solo',
      started_at: startedForLegacyDay(2)
    }));

    const open = await request('GET', '/api/checkins/60/streak', { token: tokenFor(1) });
    assert.equal(open.body.missed_days_before_today, 1);
    assert.equal(open.body.missed_days, 2);
    assert.equal(open.body.recovery_needed, true);

    const saved = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 60 }
    });
    assert.equal(saved.status, 201);
    const after = await request('GET', '/api/checkins/60/streak', { token: tokenFor(1) });
    assert.equal(after.body.recovery_needed, false);
    assert.equal(after.body.missed_days_before_today, open.body.missed_days_before_today);
    assert.equal(after.body.missed_days, 0);
    assert.equal(after.body.today_done, true);
  });
});
