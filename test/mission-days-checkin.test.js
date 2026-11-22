// Dias da missão nas rotas: check-in, sequência/Brio, dia difícil,
// conclusão no último dia e criação da missão. Banco simulado, sem Postgres.
const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');
const { NOTE_CONSENT_SQL, consentRows } = require('./helpers/note-consent-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const {
  FREE_DAY_CHECKIN_MESSAGE,
  MISSION_WEEKDAYS_FORMAT_MESSAGE,
  MISSION_WEEKDAYS_MIN_MESSAGE,
  startWeekdayFor,
  weekdayForDay
} = require('../lib/mission-days');

const checkinsRouter = require('../routes/checkins');
const missionsRouter = require('../routes/missions');

const app = express();
app.use(express.json());
app.use('/api/checkins', checkinsRouter);
app.use('/api/missions', missionsRouter);

const DAY = 24 * 60 * 60 * 1000;

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

const state = {
  users: new Map(),
  missions: new Map(),
  checkins: [],
  connects: 0,
  inserts: [],
  failInsertWith: null
};

function reset() {
  state.users.clear();
  state.missions.clear();
  state.checkins = [];
  state.connects = 0;
  state.inserts = [];
  state.failInsertWith = null;
}

function handle(sql, params = []) {
  const text = normalize(sql);

  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
  if (/^(ALTER TABLE|CREATE TABLE|WITH participant_history)/i.test(text)) return { rows: [] };
  if (/^UPDATE missions SET/i.test(text) && /COALESCE\(started_at/i.test(text)) return { rows: [] };

  if (/^INSERT INTO missions/i.test(text)) {
    state.inserts.push({ text, params });
    if (state.failInsertWith) {
      const err = new Error('coluna não existe');
      err.code = state.failInsertWith;
      throw err;
    }
    const row = { id: 50, user_id: params[0], title: params[1], status: 'waiting' };
    if (/mission_weekdays/.test(text)) row.mission_weekdays = params[14];
    state.missions.set(50, row);
    return { rows: [{ ...row }] };
  }

  if (/^UPDATE missions SET status = 'active'/i.test(text)) {
    const mission = state.missions.get(Number(params[2]));
    Object.assign(mission, { status: 'active', started_at: params[0], ends_at: params[1] });
    return { rows: [{ ...mission }] };
  }

  if (/^UPDATE missions SET (user_score|partner_score)/i.test(text)) {
    const field = /user_score/i.test(text) ? 'user_score' : 'partner_score';
    const mission = state.missions.get(Number(params[0]));
    mission[field] = Number(mission[field] || 0) + 1;
    return { rows: [] };
  }

  if (/^UPDATE missions SET status = 'completed'/i.test(text)) {
    state.missions.get(Number(params[0])).status = 'completed';
    return { rows: [] };
  }

  if (/^INSERT INTO checkins/i.test(text)) {
    const row = {
      id: state.checkins.length + 1,
      mission_id: Number(params[0]),
      user_id: Number(params[1]),
      day_number: Number(params[2]),
      completed: true,
      note: params[5] === true ? null : (params[3] || null),
      is_difficult: params[4] === true
    };
    const index = state.checkins.findIndex(item => item.mission_id === row.mission_id
      && item.user_id === row.user_id && item.day_number === row.day_number);
    if (index >= 0) {
      row.is_difficult = row.is_difficult || state.checkins[index].is_difficult;
      state.checkins[index] = row;
    } else {
      state.checkins.push(row);
    }
    return { rows: [{ ...row }] };
  }

  if (NOTE_CONSENT_SQL.test(text)) return consentRows(true);
  if (/FROM users/i.test(text) && /reminder_time/i.test(text)) {
    const user = state.users.get(Number(params[0]));
    return { rows: user ? [{ reminder_time: user.reminder_time, timezone: user.timezone }] : [] };
  }

  if (/FROM mission_matches/i.test(text)) return { rows: [] };

  if (/FROM missions/i.test(text)) {
    const mission = state.missions.get(Number(params[0]));
    if (!mission) return { rows: [] };
    const filtersMember = /partner_id = \$2/i.test(text) && params.length >= 2;
    if (filtersMember) {
      const requester = Number(params[1]);
      const allowed = Number(mission.user_id) === requester
        || (mission.partner_id != null && Number(mission.partner_id) === requester);
      if (!allowed) return { rows: [] };
    }
    return { rows: [{ ...mission }] };
  }

  if (/FROM checkins/i.test(text)) {
    let rows = state.checkins.filter(row => row.mission_id === Number(params[0]));
    if (/user_id = \$2/i.test(text)) rows = rows.filter(row => row.user_id === Number(params[1]));
    if (/is_difficult = true/i.test(text)) rows = rows.filter(row => row.is_difficult === true);
    if (/day_number = \$3/i.test(text)) rows = rows.filter(row => row.day_number === Number(params[2]));
    if (/day_number >= \$3/i.test(text)) rows = rows.filter(row => row.day_number >= Number(params[2]));
    if (/day_number >= \$2/i.test(text)) rows = rows.filter(row => row.day_number >= Number(params[1]));
    if (/completed = true/i.test(text)) rows = rows.filter(row => row.completed === true);
    return { rows: rows.map(row => ({ ...row })) };
  }

  throw new Error(`SQL inesperada no teste: ${text}`);
}

function user(id) {
  return { id, reminder_time: null, timezone: null };
}

// Relógio do servidor (sem horário escolhido): o Dia N começou há 1 minuto.
function startedForLegacyDay(dayNumber) {
  return new Date(Date.now() - (dayNumber - 1) * DAY - 60 * 1000).toISOString();
}

// Dias da semana de todos menos os dias livres pedidos (pelo número do dia).
function weekdaysWithFreeDays(startedAt, freeDays) {
  const start = startWeekdayFor(startedAt, null);
  const free = new Set(freeDays.map(day => weekdayForDay(start, day)));
  return [1, 2, 3, 4, 5, 6, 7].filter(day => !free.has(day));
}

function mission(extra = {}) {
  return {
    id: 10,
    user_id: 1,
    partner_id: null,
    user_name: 'pessoa1',
    partner_name: null,
    status: 'active',
    mode: 'solo',
    proof_mode: 'self_report',
    started_at: startedForLegacyDay(1),
    duration_days: 30,
    user_score: 0,
    partner_score: 0,
    mission_weekdays: null,
    ...extra
  };
}

function seed(row) {
  state.checkins.push({ id: state.checkins.length + 1, completed: true, note: null, is_difficult: false, ...row });
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

describe('dias da missão nas rotas', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => {
      state.connects += 1;
      return { query: async (sql, params) => handle(sql, params), release() {} };
    });
    await new Promise(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('check-in num dia livre é recusado com calma e nada é gravado', async () => {
    reset();
    state.users.set(1, user(1));
    const started = startedForLegacyDay(9);
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [9]) }));

    const plain = await request('POST', '/api/checkins', { token: tokenFor(1), body: { mission_id: 10 } });
    const difficult = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 10, difficult: true, minimum_done: true }
    });

    assert.equal(plain.status, 400);
    assert.deepEqual(plain.body, { error: FREE_DAY_CHECKIN_MESSAGE, free_day: true });
    assert.deepEqual(difficult.body, plain.body);
    assert.equal(state.checkins.length, 0);
    assert.equal(state.connects, 0);
    assert.equal(state.missions.get(10).user_score, 0);
  });

  test('nota de crise num dia livre: abre a ajuda e a nota não é guardada', async () => {
    reset();
    state.users.set(1, user(1));
    const started = startedForLegacyDay(9);
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [9]) }));

    const res = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 10, note: 'hoje eu so quero morrer' }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.free_day, true);
    assert.equal(state.checkins.length, 0);
  });

  test('negado: sem login (401) e quem não participa (404), mesmo num dia livre', async () => {
    reset();
    state.users.set(1, user(1));
    state.users.set(8, user(8));
    const started = startedForLegacyDay(9);
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [9]) }));

    const anon = await request('POST', '/api/checkins', { body: { mission_id: 10 } });
    const other = await request('POST', '/api/checkins', { token: tokenFor(8), body: { mission_id: 10 } });
    const otherStreak = await request('GET', '/api/checkins/10/streak', { token: tokenFor(8) });

    assert.equal(anon.status, 401);
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, { error: 'Missão não encontrada.' });
    assert.equal(otherStreak.status, 404);
    assert.equal(state.checkins.length, 0);
  });

  test('check-in num dia da missão continua a funcionar', async () => {
    reset();
    state.users.set(1, user(1));
    const started = startedForLegacyDay(9);
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [8]) }));

    const res = await request('POST', '/api/checkins', { token: tokenFor(1), body: { mission_id: 10 } });

    assert.equal(res.status, 201);
    assert.equal(res.body.day, 9);
    assert.equal(state.checkins.length, 1);
    assert.equal(state.missions.get(10).user_score, 1);
  });

  test('sequência e Brio sem os dias livres', async () => {
    reset();
    state.users.set(1, user(1));
    const started = startedForLegacyDay(8);
    // Dias 2, 4 e 6 livres (e os da mesma semana). Feitos: 1, 3, 5, 7, 8.
    const weekdays = weekdaysWithFreeDays(started, [2, 4, 6]);
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdays }));
    state.missions.set(11, mission({ id: 11, started_at: started }));
    for (const day of [1, 3, 5, 7, 8]) {
      seed({ mission_id: 10, user_id: 1, day_number: day });
      seed({ mission_id: 11, user_id: 1, day_number: day });
    }

    const planned = await request('GET', '/api/checkins/10/streak', { token: tokenFor(1) });
    const everyDay = await request('GET', '/api/checkins/11/streak', { token: tokenFor(1) });
    const score = await request('GET', '/api/checkins/10/score', { token: tokenFor(1) });

    assert.equal(planned.status, 200);
    assert.equal(planned.body.streak, 5);
    assert.equal(planned.body.consistency, 100);
    assert.equal(planned.body.brio, 92);
    assert.equal(planned.body.missed_days, 0);
    assert.equal(planned.body.today_is_mission_day, true);
    assert.deepEqual(planned.body.mission_weekdays, weekdays);
    assert.equal(score.body.my_streak, 5);

    // Sem dias escolhidos, os mesmos check-ins têm buracos: como antes.
    assert.equal(everyDay.body.streak, 2);
    assert.equal(everyDay.body.consistency, 63);
    assert.equal(everyDay.body.mission_weekdays, null);
    assert.equal(everyDay.body.today_is_mission_day, true);
  });

  test('hoje é dia livre: sequência mantida e sem recuperação pedida', async () => {
    reset();
    state.users.set(1, user(1));
    const started = startedForLegacyDay(9);
    // O Dia 9 cai no mesmo dia da semana do Dia 2: os dois são livres.
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [2, 4, 6]) }));
    for (const day of [1, 3, 5, 7, 8]) seed({ mission_id: 10, user_id: 1, day_number: day });

    const res = await request('GET', '/api/checkins/10/streak', { token: tokenFor(1) });

    assert.equal(res.body.today_is_mission_day, false);
    assert.equal(res.body.today_done, false);
    assert.equal(res.body.streak, 5);
    assert.equal(res.body.missed_days, 0);
    assert.equal(res.body.recovery_needed, false);
    assert.equal(res.body.consistency, 100);
  });

  test('dia difícil: difícil, livre, difícil, difícil é permitido', async () => {
    reset();
    state.users.set(1, user(1));
    const started = startedForLegacyDay(8);
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [6]) }));
    seed({ mission_id: 10, user_id: 1, day_number: 5, is_difficult: true });
    seed({ mission_id: 10, user_id: 1, day_number: 7, is_difficult: true });

    const res = await request('POST', '/api/checkins', {
      token: tokenFor(1),
      body: { mission_id: 10, difficult: true, minimum_done: true }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.checkin.is_difficult, true);
  });

  test('Dia 30 em dia livre: a missão conclui ao fazer o último dia da missão', async () => {
    reset();
    state.users.set(1, user(1));
    const started = startedForLegacyDay(29);
    state.missions.set(10, mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [30]) }));
    state.missions.set(11, mission({ id: 11, started_at: started }));
    state.missions.set(12, mission({ id: 12, started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [28]) }));

    const planned = await request('POST', '/api/checkins', { token: tokenFor(1), body: { mission_id: 10 } });
    const everyDay = await request('POST', '/api/checkins', { token: tokenFor(1), body: { mission_id: 11 } });
    const lastIsMission = await request('POST', '/api/checkins', { token: tokenFor(1), body: { mission_id: 12 } });

    assert.equal(planned.status, 201);
    assert.equal(planned.body.day, 29);
    assert.equal(state.missions.get(10).status, 'completed');
    // Sem dias escolhidos, ou com o Dia 30 sendo dia da missão: só o Dia 30 conclui.
    assert.equal(everyDay.status, 201);
    assert.equal(state.missions.get(11).status, 'active');
    assert.equal(lastIsMission.status, 201);
    assert.equal(state.missions.get(12).status, 'active');
  });

  test('Duo na mesma missão: conclui quando os dois fizeram o último dia da missão', async () => {
    reset();
    state.users.set(1, user(1));
    state.users.set(2, user(2));
    const started = startedForLegacyDay(29);
    state.missions.set(10, mission({
      partner_id: 2,
      mode: 'parceiro',
      started_at: started,
      mission_weekdays: weekdaysWithFreeDays(started, [30])
    }));

    const partnerFirst = await request('POST', '/api/checkins', { token: tokenFor(2), body: { mission_id: 10 } });
    assert.equal(partnerFirst.status, 201);
    assert.equal(state.missions.get(10).status, 'active');

    seed({ mission_id: 10, user_id: 1, day_number: 29 });
    const partnerAgain = await request('POST', '/api/checkins', { token: tokenFor(2), body: { mission_id: 10 } });
    assert.equal(partnerAgain.status, 201);
    assert.equal(state.missions.get(10).status, 'completed');
  });

  test('criar missão: dias da missão válidos entram no INSERT, ordenados', async () => {
    reset();
    const res = await request('POST', '/api/missions', {
      token: tokenFor(1),
      body: { title: 'Estudar', category: 'estudo', mission_weekdays: [5, 1, 3] }
    });

    assert.equal(res.status, 201);
    assert.equal(state.inserts.length, 1);
    assert.match(state.inserts[0].text, /mission_weekdays/);
    assert.match(state.inserts[0].text, /\$15::smallint\[\]/);
    assert.deepEqual(state.inserts[0].params[14], [1, 3, 5]);
    assert.deepEqual(res.body.mission.mission_weekdays, [1, 3, 5]);
  });

  test('criar missão sem escolher dias: INSERT igual ao de antes', async () => {
    reset();
    const res = await request('POST', '/api/missions', {
      token: tokenFor(1),
      body: { title: 'Correr', category: 'treino' }
    });

    assert.equal(res.status, 201);
    assert.doesNotMatch(state.inserts[0].text, /mission_weekdays/);
    assert.equal(state.inserts[0].params.length, 14);
  });

  test('criar missão negado: menos de 3 dias, dia inválido, repetido, sem login', async () => {
    reset();
    const cases = [
      [[1, 2], MISSION_WEEKDAYS_MIN_MESSAGE],
      [[], MISSION_WEEKDAYS_MIN_MESSAGE],
      [[0, 1, 2], MISSION_WEEKDAYS_FORMAT_MESSAGE],
      [[1, 2, 8], MISSION_WEEKDAYS_FORMAT_MESSAGE],
      [[1, 1, 2, 3], MISSION_WEEKDAYS_FORMAT_MESSAGE],
      [['seg', 'qua', 'sex'], MISSION_WEEKDAYS_FORMAT_MESSAGE],
      ['1,3,5', MISSION_WEEKDAYS_FORMAT_MESSAGE]
    ];
    for (const [value, message] of cases) {
      const res = await request('POST', '/api/missions', {
        token: tokenFor(1),
        body: { title: 'Estudar', category: 'estudo', mission_weekdays: value }
      });
      assert.equal(res.status, 400, JSON.stringify(value));
      assert.deepEqual(res.body, { error: message });
    }
    const anon = await request('POST', '/api/missions', {
      body: { title: 'Estudar', category: 'estudo', mission_weekdays: [1, 3, 5] }
    });
    assert.equal(anon.status, 401);
    assert.equal(state.inserts.length, 0);
  });

  test('criar missão com dias antes da migração 004: erro calmo, nada criado', async () => {
    reset();
    state.failInsertWith = '42703';
    const res = await request('POST', '/api/missions', {
      token: tokenFor(1),
      body: { title: 'Estudar', category: 'estudo', mission_weekdays: [1, 3, 5] }
    });

    assert.equal(res.status, 503);
    assert.match(res.body.error, /ainda não está disponível/);
    assert.equal(state.missions.size, 0);
  });
});
