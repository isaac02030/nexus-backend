process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const {
  REMINDER_TIME_MESSAGE,
  TIMEZONE_MESSAGE
} = require('../lib/reminder-schedule');
const usersRouter = require('../routes/users');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

const reminders = new Map();
const updates = [];

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handleQuery(sql, params = []) {
  const text = normalize(sql);

  if (/^ALTER TABLE users/i.test(text)) {
    return { rows: [], rowCount: 0 };
  }

  if (/^SELECT to_char\(reminder_time/i.test(text)) {
    const user = reminders.get(Number(params[0]));
    if (!user) return { rows: [] };
    return { rows: [{ reminder_time: user.reminder_time, timezone: user.timezone }] };
  }

  if (/^UPDATE users/i.test(text) && /reminder_time/i.test(text)) {
    const userId = Number(params[2]);
    const user = reminders.get(userId);
    updates.push(userId);
    if (!user) return { rows: [] };
    user.reminder_time = params[0];
    user.timezone = params[1];
    return { rows: [{ reminder_time: user.reminder_time, timezone: user.timezone }] };
  }

  throw new Error(`SQL inesperada no teste: ${text}`);
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

function resetReminders() {
  reminders.clear();
  reminders.set(1, { reminder_time: null, timezone: null });
  reminders.set(2, { reminder_time: '07:15', timezone: 'Europe/Lisbon' });
  updates.length = 0;
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

describe('lembrete da propria pessoa', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', handleQuery);
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('sem login o GET e o PUT respondem 401', async () => {
    resetReminders();

    const get = await request('GET', '/api/users/me/reminder');
    const put = await request('PUT', '/api/users/me/reminder', {
      body: { reminder_time: '08:30', timezone: 'America/Sao_Paulo' }
    });

    assert.equal(get.status, 401);
    assert.equal(put.status, 401);
    assert.deepEqual(updates, []);
    assert.equal(reminders.get(1).reminder_time, null);
    assert.equal(reminders.get(2).reminder_time, '07:15');
  });

  test('uma pessoa nao altera o lembrete de outra', async () => {
    resetReminders();

    const saved = await request('PUT', '/api/users/me/reminder', {
      token: tokenFor(1),
      body: { reminder_time: '08:30', timezone: 'America/Sao_Paulo', user_id: 2 }
    });
    const mine = await request('GET', '/api/users/me/reminder', { token: tokenFor(1) });
    const other = await request('GET', '/api/users/me/reminder', { token: tokenFor(2) });

    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });
    assert.deepEqual(mine.body, { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });
    assert.deepEqual(other.body, { reminder_time: '07:15', timezone: 'Europe/Lisbon' });
    assert.deepEqual(updates, [1]);
  });

  test('horario ou fuso invalido responde 400 e nao grava', async () => {
    resetReminders();
    reminders.set(1, { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });

    const badTime = await request('PUT', '/api/users/me/reminder', {
      token: tokenFor(1),
      body: { reminder_time: '24:00', timezone: 'America/Sao_Paulo' }
    });
    const badZone = await request('PUT', '/api/users/me/reminder', {
      token: tokenFor(1),
      body: { reminder_time: '08:30', timezone: 'America/Sao Paulo' }
    });
    const mine = await request('GET', '/api/users/me/reminder', { token: tokenFor(1) });
    const other = await request('GET', '/api/users/me/reminder', { token: tokenFor(2) });

    assert.equal(badTime.status, 400);
    assert.equal(badTime.body.error, REMINDER_TIME_MESSAGE);
    assert.equal(badZone.status, 400);
    assert.equal(badZone.body.error, TIMEZONE_MESSAGE);
    assert.deepEqual(updates, []);
    assert.deepEqual(mine.body, { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });
    assert.deepEqual(other.body, { reminder_time: '07:15', timezone: 'Europe/Lisbon' });
  });
});
