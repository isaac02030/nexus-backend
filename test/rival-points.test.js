const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

// Pontos do Rival (decisão de 26/11): 10 por dia cumprido (o dia difícil
// conta), dia livre e falta não pontuam, sem bônus, só desde o início do par.
const { POINTS_PER_DAY, rivalPoints } = require('../lib/rival-points');
const checkinsRouter = require('../routes/checkins');

const app = express();
app.use(express.json());
app.use('/api/checkins', checkinsRouter);

const PAIR_START = new Date('2026-11-20T00:00:00Z');
const BEFORE = new Date('2026-11-19T10:00:00Z');
const AFTER = new Date('2026-11-21T10:00:00Z');

const db = {};

function resetDb() {
  db.users = new Map([[1, 'alfa'], [2, 'beta'], [3, 'gama'], [4, 'delta'], [5, 'eps'], [6, 'zeta'], [9, 'fora']]);
  db.missions = [
    // Rival por mission_matches: cada um com a sua missão.
    { id: 10, user_id: 1, partner_id: 2, mode: 'rival', status: 'active', started_at: '2026-11-18T12:00:00', mission_weekdays: null, pair_started_at: PAIR_START },
    { id: 11, user_id: 2, partner_id: 1, mode: 'rival', status: 'active', started_at: '2026-11-18T12:00:00', mission_weekdays: null, pair_started_at: PAIR_START },
    // Duo na mesma missão, com dias da missão seg, qua e sex (Dia 1 = segunda).
    { id: 20, user_id: 3, partner_id: 4, mode: 'parceiro', status: 'active', started_at: '2026-11-02T12:00:00', mission_weekdays: [1, 3, 5], pair_started_at: new Date('2026-11-01T00:00:00Z') },
    // Par sem início conhecido (falha fechada).
    { id: 30, user_id: 5, partner_id: 6, mode: 'rival', status: 'active', started_at: '2026-11-02T12:00:00', mission_weekdays: null, pair_started_at: null }
  ];
  db.matches = [{ mission_a_id: 10, mission_b_id: 11, status: 'active', started_at: PAIR_START }];
  db.checkins = [
    // alfa: dias 1 e 2 antes do par (não contam); 3 normal e 4 difícil depois.
    { mission_id: 10, user_id: 1, day_number: 1, completed: true, created_at: BEFORE },
    { mission_id: 10, user_id: 1, day_number: 2, completed: true, created_at: BEFORE },
    { mission_id: 10, user_id: 1, day_number: 3, completed: true, created_at: AFTER },
    { mission_id: 10, user_id: 1, day_number: 4, completed: true, is_difficult: true, created_at: AFTER },
    // beta: dia 3 cumprido; dia 4 falhou (completed false).
    { mission_id: 11, user_id: 2, day_number: 3, completed: true, created_at: AFTER },
    { mission_id: 11, user_id: 2, day_number: 4, completed: false, created_at: AFTER },
    // gama: dia 1 (segunda) e dia 2 (terça, dia livre: linha antiga, não pontua).
    { mission_id: 20, user_id: 3, day_number: 1, completed: true, created_at: AFTER },
    { mission_id: 20, user_id: 3, day_number: 2, completed: true, created_at: AFTER },
    // delta: dia 3 (quarta) como dia difícil.
    { mission_id: 20, user_id: 4, day_number: 3, completed: true, is_difficult: true, created_at: AFTER },
    { mission_id: 30, user_id: 5, day_number: 1, completed: true, created_at: AFTER }
  ];
  db.queries = [];
}

const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const mission = (id) => db.missions.find((m) => m.id === Number(id));
const activeMatch = (id) => db.matches.find((mm) => mm.status === 'active' && (mm.mission_a_id === id || mm.mission_b_id === id));

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (/FROM missions m LEFT JOIN users u1 ON m\.user_id = u1\.id/.test(text)) {
    const m = mission(params[0]);
    const uid = Number(params[1]);
    if (!m || (m.user_id !== uid && m.partner_id !== uid)) return { rows: [] };
    return { rows: [{ ...m, user_name: db.users.get(m.user_id), partner_name: db.users.get(m.partner_id) || null }] };
  }
  if (/^SELECT mission_a_id, mission_b_id, started_at FROM mission_matches/.test(text)) {
    const mm = activeMatch(Number(params[0]));
    return { rows: mm ? [{ ...mm }] : [] };
  }
  if (/COUNT\(\*\) AS days_completed/.test(text)) {
    const ids = params[0].map(Number);
    const since = params[1] ? new Date(params[1]).getTime() : null;
    const groups = new Map();
    for (const c of db.checkins) {
      if (!ids.includes(c.mission_id) || !c.completed) continue;
      if (since !== null && c.created_at.getTime() < since) continue;
      const key = `${c.mission_id}|${c.user_id}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return { rows: [...groups].map(([k, n]) => ({ mission_id: Number(k.split('|')[0]), user_id: Number(k.split('|')[1]), days_completed: String(n) })) };
  }
  if (/^SELECT user_id FROM missions WHERE id = \$1$/.test(text)) {
    const m = mission(params[0]);
    return { rows: m ? [{ user_id: m.user_id }] : [] };
  }
  if (/^SELECT id, started_at, mission_weekdays FROM missions WHERE id = \$1$/.test(text)) {
    const m = mission(params[0]);
    return { rows: m ? [{ id: m.id, started_at: m.started_at, mission_weekdays: m.mission_weekdays }] : [] };
  }
  if (/FROM users WHERE id = \$1$/.test(text) && /reminder_time/.test(text)) {
    return { rows: [{ reminder_time: null, timezone: null }] };
  }
  if (/^SELECT mission_id, user_id, day_number, completed FROM checkins/.test(text)) {
    assert.match(text, /created_at >= \$2::timestamp/, 'o corte pelo início do par é feito no SQL (relógio do banco)');
    const ids = params[0].map(Number);
    const since = params[1] ? new Date(params[1]).getTime() : null;
    return {
      rows: db.checkins.filter((c) => ids.includes(c.mission_id) && c.completed
        && (since === null || c.created_at.getTime() >= since))
        .map(({ mission_id, user_id, day_number, completed }) => ({ mission_id, user_id, day_number, completed }))
    };
  }
  if (/^SELECT day_number FROM checkins/.test(text)) {
    return { rows: db.checkins.filter((c) => c.mission_id === Number(params[0]) && c.user_id === Number(params[1]) && c.completed)
      .map((c) => ({ day_number: c.day_number })) };
  }
  return { rows: [] };
}

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);
let server;
let baseUrl;

async function score(missionId, userId) {
  const response = await fetch(`${baseUrl}/api/checkins/${missionId}/score`, {
    headers: userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}
  });
  return { status: response.status, body: await response.json() };
}

describe('pontos do Rival: a conta (lib/rival-points.js)', () => {
  test('10 por dia cumprido; dia difícil vale 10', () => {
    assert.equal(POINTS_PER_DAY, 10);
    assert.equal(rivalPoints([{ day_number: 1, completed: true }]), 10);
    assert.equal(rivalPoints([{ day_number: 2, completed: true, is_difficult: true }]), 10);
    assert.equal(rivalPoints([{ day_number: 1, completed: true }, { day_number: 2, completed: true }]), 20);
  });

  test('negado: falta e dia livre não pontuam; dia repetido conta uma vez; sem bônus', () => {
    assert.equal(rivalPoints([{ day_number: 1, completed: false }]), 0, 'falta');
    assert.equal(rivalPoints([]), 0, 'dia sem registro');
    assert.equal(rivalPoints([{ day_number: 2, completed: true }], (d) => d !== 2), 0, 'dia livre');
    assert.equal(rivalPoints([{ day_number: 1, completed: true }, { day_number: 1, completed: true }]), 10);
    assert.equal(rivalPoints([{ day_number: 1, completed: true, bonus: 50, effort: 99 }]), 10, 'nenhum campo de bônus soma');
    assert.equal(rivalPoints([{ day_number: 0, completed: true }, { day_number: 'x', completed: true }]), 0);
  });
});

describe('pontos do Rival: GET /api/checkins/:id/score', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(resetDb);

  test('Rival por par: pontos dos dois, só depois do início do par; o dia difícil dá 10', async () => {
    const res = await score(10, 1);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.points, { alfa: 20, beta: 10 });
    assert.equal(res.body.points_per_day, 10);
  });

  test('o outro lado vê o mesmo placar, do ponto de vista dele', async () => {
    const res = await score(11, 2);
    assert.deepEqual(res.body.points, { beta: 10, alfa: 20 });
  });

  test('o que o site já usa continua igual (scores em dias, leader, my_streak)', async () => {
    const res = await score(10, 1);
    assert.deepEqual(res.body.scores, { alfa: 2, beta: 1 });
    assert.equal(res.body.leader, 'alfa');
    assert.equal(typeof res.body.my_streak, 'number');
    assert.equal(res.body.mode, 'rival');
  });

  test('negado: falta não pontua (beta faltou no dia 4)', async () => {
    const res = await score(11, 2);
    assert.equal(res.body.points.beta, 10);
  });

  test('negado: dia livre não pontua (Duo na mesma missão com dias escolhidos)', async () => {
    const res = await score(20, 3);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.points, { gama: 10, delta: 10 });
  });

  test('negado: par sem início conhecido não pontua (falha fechada)', async () => {
    const res = await score(30, 5);
    assert.deepEqual(res.body.points, { eps: 0, zeta: 0 });
  });

  test('negado: quem não participa recebe a mesma resposta de missão inexistente', async () => {
    const denied = await score(10, 9);
    const missing = await score(999, 9);
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, missing.body);
    assert.equal(denied.body.points, undefined);
  });

  test('negado: sem login, 401', async () => {
    const res = await score(10);
    assert.equal(res.status, 401);
    assert.equal(res.body.points, undefined);
  });
});
