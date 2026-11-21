// Insights do admin (routes/insights.js) e dias livres. Banco simulado:
// as linhas que o SQL devolveria são montadas aqui; o teste confere o que a
// rota faz com elas.
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { startWeekdayFor, weekdayForDay } = require('../lib/mission-days');

const DAY = 24 * 60 * 60 * 1000;

const state = { first: [], inactive: [], latest: [], clockQueries: 0, sql: [] };

function reset() {
  state.first = [];
  state.inactive = [];
  state.latest = [];
  state.clockQueries = 0;
  state.sql = [];
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql) {
  const text = normalize(sql);
  state.sql.push(text);
  if (/AS total_users/.test(text)) {
    return { rows: [{ total_users: '3', new_users_7d: '1', total_participants: '3', waiting_missions: '0',
      active_missions: '3', completed_missions: '0', checked_today: '1' }] };
  }
  if (/AS next_done_day/.test(text)) return { rows: state.first.map(r => ({ ...r })) };
  if (/AS missed_days/.test(text)) return { rows: state.inactive.map(r => ({ ...r })) };
  if (/LEFT JOIN LATERAL/.test(text)) return { rows: state.latest.map(r => ({ ...r })) };
  if (/id = ANY/.test(text)) {
    state.clockQueries += 1;
    return { rows: [] };
  }
  if (/HAVING COUNT/.test(text) || /NOT EXISTS/.test(text) || /m.status = 'waiting'/.test(text)) {
    return { rows: [] };
  }
  throw new Error(`SQL inesperada no teste: ${text}`);
}

function startedForLegacyDay(dayNumber) {
  return new Date(Date.now() - (dayNumber - 1) * DAY - 60 * 1000).toISOString();
}

function weekdaysWithFreeDays(startedAt, freeDays) {
  const start = startWeekdayFor(startedAt, null);
  const free = new Set(freeDays.map(day => weekdayForDay(start, day)));
  return [1, 2, 3, 4, 5, 6, 7].filter(day => !free.has(day));
}

function inactiveRow(extra) {
  return {
    mission_id: 10, user_id: 1, title: 'missao', category: 'habito', mode: 'solo', username: 'pessoa',
    mission_created_at: '2026-11-01T10:00:00.000Z', started_at: startedForLegacyDay(6), duration_days: 30,
    mission_weekdays: null, current_day: 6, last_checkin_day: 3, missed_days: 3,
    ...extra
  };
}

function latestRow(extra) {
  return {
    id: 1, username: 'pessoa', created_at: '2026-11-01T09:00:00.000Z', title: 'missao', category: 'habito',
    mode: 'solo', status: 'active', completed_checkins: '2', current_day: 6, last_checkin_day: 3,
    started_at: startedForLegacyDay(6), duration_days: 30, mission_weekdays: null,
    ...extra
  };
}

let server;
let baseUrl;

async function get(token) {
  const response = await fetch(`${baseUrl}/api/insights/overview`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  return { status: response.status, body: await response.json() };
}

const admin = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);

describe('insights e dias livres', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', async sql => handle(sql));
    const app = express();
    app.use('/api/insights', require('../routes/insights'));
    await new Promise(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('negado: sem login (401) e quem não é admin (403)', async () => {
    reset();
    const anon = await get();
    const other = await get(jwt.sign({ userId: 8 }, process.env.JWT_SECRET));
    assert.equal(anon.status, 401);
    assert.equal(other.status, 403);
    assert.equal(state.sql.length, 0);
  });

  test('as consultas leem os dias da missão sem depender da migração', async () => {
    reset();
    await get(admin);
    const withWeekdays = state.sql.filter(text => /mission_weekdays/.test(text));
    assert.equal(withWeekdays.length, 3);
    for (const text of withWeekdays) {
      assert.doesNotMatch(text.replace(/to_jsonb\(m\) -> 'mission_weekdays'/g, ''), /m\.mission_weekdays/);
    }
  });

  test('sem dias escolhidos (NULL ou sem a coluna): números do SQL, como antes, sem consulta extra', async () => {
    reset();
    const noColumn = inactiveRow({ mission_id: 11 });
    delete noColumn.mission_weekdays;
    state.inactive = [inactiveRow(), noColumn];
    state.latest = [latestRow()];
    state.first = [
      { mission_id: 10, user_id: 1, first_day: 1, next_done_day: 2, duration_days: 30, mission_weekdays: null },
      { mission_id: 11, user_id: 2, first_day: 1, next_done_day: 3, duration_days: 30 }
    ];

    const res = await get(admin);

    assert.equal(res.status, 200);
    assert.equal(res.body.summary.returned_next_day_rate, 50);
    assert.deepEqual(res.body.blockers.inactive_participants.map(r => [r.current_day, r.missed_days]), [[6, 3], [6, 3]]);
    assert.deepEqual(Object.keys(res.body.blockers.inactive_participants[0]).sort(), [
      'category', 'current_day', 'last_checkin_day', 'missed_days', 'mission_created_at', 'mission_id', 'mode', 'title', 'username'
    ]);
    assert.equal(res.body.latest_users[0].status_label, 'sumiu ha 3 dias');
    assert.equal(state.clockQueries, 0);
  });

  test('dias livres não contam como falta (lista de sumidos e rótulo)', async () => {
    reset();
    const started = startedForLegacyDay(6);
    // Último feito: Dia 3. Dias 4 e 5 livres: só o Dia 6 (hoje) falta.
    const weekdays = weekdaysWithFreeDays(started, [4, 5]);
    state.inactive = [
      inactiveRow({ started_at: started, mission_weekdays: weekdays }),
      // Dia 5 livre: faltam 4 e 6.
      inactiveRow({ mission_id: 12, started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [5]) }),
      // O SQL deixaria passar (prefiltro), mas com 1 dia só não entra.
      inactiveRow({ mission_id: 13, started_at: started, last_checkin_day: 5, mission_weekdays: weekdays })
    ];
    state.latest = [latestRow({ started_at: started, mission_weekdays: weekdays })];

    const res = await get(admin);

    assert.deepEqual(
      res.body.blockers.inactive_participants.map(r => [r.mission_id, r.current_day, r.missed_days]),
      [[12, 6, 2]]
    );
    assert.equal(res.body.latest_users[0].status_label, 'ativo no ciclo');
    assert.equal(state.clockQueries, 1);
  });

  test('voltar no dia seguinte: com dias escolhidos, é o próximo dia da missão', async () => {
    reset();
    const started = startedForLegacyDay(6);
    const weekdays = weekdaysWithFreeDays(started, [2]);
    state.first = [
      // Dia 2 livre: voltar no Dia 3 conta como voltar no dia seguinte.
      { mission_id: 10, user_id: 1, first_day: 1, next_done_day: 3, started_at: started, duration_days: 30, mission_weekdays: weekdays },
      // Sem dias escolhidos: Dia 3 não é o dia seguinte ao Dia 1.
      { mission_id: 11, user_id: 2, first_day: 1, next_done_day: 3, started_at: started, duration_days: 30, mission_weekdays: null },
      // Pulou o Dia 3 (da missão): não voltou no dia seguinte.
      { mission_id: 12, user_id: 3, first_day: 1, next_done_day: 4, started_at: started, duration_days: 30, mission_weekdays: weekdays },
      // Nunca voltou.
      { mission_id: 13, user_id: 4, first_day: 1, next_done_day: null, started_at: started, duration_days: 30, mission_weekdays: weekdays }
    ];

    const res = await get(admin);

    assert.equal(res.body.summary.returned_next_day_rate, 25);
  });

  test('mais de 8 sumidos: só os 8 mais recentes, como antes', async () => {
    reset();
    state.inactive = Array.from({ length: 10 }, (_, index) => inactiveRow({ mission_id: 100 + index }));
    const res = await get(admin);
    assert.deepEqual(res.body.blockers.inactive_participants.map(r => r.mission_id), [100, 101, 102, 103, 104, 105, 106, 107]);
  });
});
