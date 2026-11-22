// Grande Irmão (routes/vertice.js) e dias livres. Banco simulado, sem Postgres.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.VERTICE_SECRET = 'segredo-de-teste';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const webpush = require('web-push');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');
const {
  FREE_DAY_CHECKIN_MESSAGE,
  startWeekdayFor,
  weekdayForDay
} = require('../lib/mission-days');

const DAY = 24 * 60 * 60 * 1000;

const state = { missions: [], checkins: [], users: new Map(), clockQueries: 0, pushes: [] };
let lastPushUser = null;

function reset() {
  state.missions = [];
  state.checkins = [];
  state.users = new Map();
  state.clockQueries = 0;
  state.pushes = [];
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql, params = []) {
  const text = normalize(sql);

  if (/^SELECT u.id FROM users u WHERE/i.test(text) && /news_opt_in/.test(text)) return { rows: [] };
  if (/FROM users/i.test(text) && /reminder_time/i.test(text)) {
    state.clockQueries += 1;
    const user = state.users.get(Number(params[0]));
    return { rows: user ? [{ reminder_time: user.reminder_time, timezone: user.timezone }] : [] };
  }

  if (/FROM missions m/i.test(text)) {
    let rows = state.missions.filter(m => ['active', 'waiting'].includes(m.status));
    if (/m.user_id = \$1 OR m.partner_id = \$1/.test(text)) {
      const userId = Number(params[0]);
      rows = rows.filter(m => Number(m.user_id) === userId || Number(m.partner_id) === userId);
    }
    if (/m.id = \$2/.test(text)) rows = rows.filter(m => Number(m.id) === Number(params[1]));
    return { rows: rows.map(m => ({ ...m })) };
  }

  if (/FROM checkins/i.test(text) && /GROUP BY user_id/i.test(text)) {
    const counts = new Map();
    for (const row of state.checkins.filter(c => c.mission_id === Number(params[0]) && c.completed)) {
      counts.set(row.user_id, (counts.get(row.user_id) || 0) + 1);
    }
    return { rows: [...counts].map(([user_id, days]) => ({ user_id, days: String(days) })) };
  }

  if (/FROM checkins/i.test(text)) {
    let rows = state.checkins.filter(c => c.mission_id === Number(params[0]) && c.user_id === Number(params[1]));
    if (/day_number = \$3/.test(text)) rows = rows.filter(c => c.day_number === Number(params[2]));
    if (/completed = true/.test(text)) rows = rows.filter(c => c.completed);
    return { rows: rows.map(c => ({ ...c })) };
  }

  if (/FROM push_subscriptions/i.test(text)) {
    lastPushUser = Number(params[0]);
    return { rows: [{ endpoint: 'https://push.example.test/sub', p256dh: 'chave-de-teste', auth: 'auth-de-teste' }] };
  }

  throw new Error(`SQL inesperada no teste: ${text}`);
}

// Relógio do servidor (sem horário escolhido): o Dia N começou há 1 minuto.
function startedForLegacyDay(dayNumber) {
  return new Date(Date.now() - (dayNumber - 1) * DAY - 60 * 1000).toISOString();
}

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
    partner_name: null,
    status: 'active',
    mode: 'solo',
    category: null,
    started_at: startedForLegacyDay(1),
    duration_days: 30,
    mission_weekdays: null,
    created_at: new Date().toISOString(),
    ...extra
  };
}

function done(day, userId = 1) {
  state.checkins.push({ mission_id: 10, user_id: userId, day_number: day, completed: true, note: null });
}

let server;
let baseUrl;

async function request(method, path, { token, headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : {} };
}

const tokenFor = userId => jwt.sign({ userId }, process.env.JWT_SECRET);

describe('Grande Irmão e dias livres', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(webpush, 'sendNotification', async (_sub, payload) => {
      state.pushes.push({ userId: lastPushUser, ...JSON.parse(payload) });
    });
    // Sorteio fixo: sempre a primeira frase de cada lista.
    mock.method(Math, 'random', () => 0);
    const app = express();
    app.use(express.json());
    app.use('/api/vertice', require('../routes/vertice'));
    await new Promise(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('dia livre: mensagem calma de dia livre, sem cobrar check-in nem falar em falta', async () => {
    reset();
    const started = startedForLegacyDay(5);
    state.missions.push(mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [4, 5]) }));
    done(1); done(2);

    const res = await request('GET', '/api/vertice/message', { token: tokenFor(1) });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      message: FREE_DAY_CHECKIN_MESSAGE,
      day: 5,
      mode: 'solo',
      user_done: false,
      free_day: true
    });
    assert.doesNotMatch(res.body.message, /falt|falh|atras|perd/i);
  });

  test('dia livre no Duo e com categoria: a mesma mensagem calma', async () => {
    reset();
    const started = startedForLegacyDay(5);
    state.missions.push(mission({
      mode: 'parceiro',
      partner_id: 2,
      category: 'habito',
      started_at: started,
      mission_weekdays: weekdaysWithFreeDays(started, [5])
    }));
    done(5, 2);

    const me = await request('GET', '/api/vertice/message?mission_id=10', { token: tokenFor(1) });
    const partner = await request('GET', '/api/vertice/message', { token: tokenFor(2) });

    assert.equal(me.body.message, FREE_DAY_CHECKIN_MESSAGE);
    assert.equal(me.body.free_day, true);
    assert.equal(partner.body.message, FREE_DAY_CHECKIN_MESSAGE);
  });

  test('dia da missão depois de um dia livre: não pede recuperação', async () => {
    reset();
    const started = startedForLegacyDay(5);
    state.missions.push(mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [4]) }));
    done(1); done(2); done(3);

    const res = await request('GET', '/api/vertice/message', { token: tokenFor(1) });

    // Primeira frase do lembrete comum, não a de "Ontem caiu".
    assert.equal(res.body.message, 'O check-in de hoje ainda nao foi feito.');
    assert.equal(res.body.free_day, undefined);
    assert.equal(res.body.day, 5);
  });

  test('sequência: o dia livre não soma nem quebra', async () => {
    reset();
    const started = startedForLegacyDay(5);
    state.missions.push(mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [2, 4]) }));
    done(1); done(3); done(5);

    const res = await request('GET', '/api/vertice/message', { token: tokenFor(1) });

    // 3 dias da missão seguidos (1, 3, 5): frase de sequência com 3.
    assert.equal(res.body.message, '3 dias seguidos. Continua.');
  });

  test('sem dias escolhidos (NULL): tudo como antes, sem consulta extra', async () => {
    reset();
    state.missions.push(mission({ started_at: startedForLegacyDay(5) }));
    done(1); done(2); done(3);

    const res = await request('GET', '/api/vertice/message', { token: tokenFor(1) });

    // Dia 4 sem check-in: como antes, pede recuperação.
    assert.equal(res.body.message, 'Ontem caiu. Hoje recuperas.');
    assert.equal(res.body.free_day, undefined);
    assert.equal(state.clockQueries, 0);

    reset();
    state.missions.push(mission({ started_at: startedForLegacyDay(5) }));
    done(4); done(5);
    const streak = await request('GET', '/api/vertice/message', { token: tokenFor(1) });
    // Sequência de 2: frase do Dia N, como antes.
    assert.equal(streak.body.message, 'Dia 5. Mantens.');
  });

  test('sem a migração aplicada (sem a coluna): igual a hoje', async () => {
    reset();
    const row = mission({ started_at: startedForLegacyDay(5) });
    delete row.mission_weekdays;
    state.missions.push(row);
    done(1); done(2); done(3);

    const res = await request('GET', '/api/vertice/message', { token: tokenFor(1) });

    assert.equal(res.body.message, 'Ontem caiu. Hoje recuperas.');
    assert.deepEqual(Object.keys(res.body).sort(), ['day', 'message', 'mode', 'user_done']);
    assert.equal(state.clockQueries, 0);
  });

  test('com dias escolhidos, o dia usa o horário e o fuso da pessoa (o corte do check-in)', async () => {
    reset();
    state.users.set(1, { reminder_time: null, timezone: null });
    const started = startedForLegacyDay(3);
    state.missions.push(mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [3]) }));

    const res = await request('GET', '/api/vertice/message', { token: tokenFor(1) });

    assert.equal(state.clockQueries, 1);
    assert.equal(res.body.free_day, true);
  });

  test('negado: sem login (401), outra pessoa e ex-participante não veem a missão', async () => {
    reset();
    const started = startedForLegacyDay(5);
    state.missions.push(mission({ started_at: started, mission_weekdays: weekdaysWithFreeDays(started, [5]) }));

    const anon = await request('GET', '/api/vertice/message');
    const other = await request('GET', '/api/vertice/message?mission_id=10', { token: tokenFor(8) });
    // Ex-participante: já não é user_id nem partner_id da missão.
    const former = await request('GET', '/api/vertice/message', { token: tokenFor(2) });

    assert.equal(anon.status, 401);
    assert.deepEqual(other.body, { message: 'Sem missão ativa.' });
    assert.deepEqual(former.body, { message: 'Sem missão ativa.' });
  });

  test('envio para todos não manda mais a frase da missão (só novidades, para quem escolheu)', async () => {
    reset();
    const started = startedForLegacyDay(5);
    state.missions.push(mission({ id: 12, user_id: 3, started_at: started }));

    const res = await request('POST', '/api/vertice/notify-all', {
      headers: { 'x-vertice-secret': 'segredo-de-teste' },
      body: { title: 'Novidade', body: 'Texto da novidade.' }
    });

    // Ninguém aqui tem novidades = sim: nada sai, e as missões nem são lidas.
    assert.equal(res.status, 200);
    assert.equal(res.body.notifications_sent, 0);
    assert.equal(state.pushes.length, 0);
  });

  test('envio para todos negado sem o segredo', async () => {
    reset();
    state.missions.push(mission());

    const res = await request('POST', '/api/vertice/notify-all', { headers: { 'x-vertice-secret': 'errado' } });

    assert.equal(res.status, 401);
    assert.equal(state.pushes.length, 0);
  });
});
