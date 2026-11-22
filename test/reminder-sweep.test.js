process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

const pushes = [];
const inserts = [];
let currentMission = null;
let lastUserId = null;
let runReminderSweep;

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handleQuery(sql, params = []) {
  const text = normalize(sql);

  if (/^ALTER TABLE users/i.test(text) || /^CREATE TABLE IF NOT EXISTS notification_log/i.test(text)) {
    return { rows: [], rowCount: 0 };
  }

  if (/FROM missions m/i.test(text)) {
    return { rows: currentMission ? [currentMission] : [] };
  }

  if (/FROM checkins/i.test(text) && /day_number IN/i.test(text)) {
    return { rows: [] };
  }

  if (/created_at AT TIME ZONE/i.test(text)) {
    return { rows: [] };
  }

  if (/FROM notification_log/i.test(text)) {
    return { rows: [] };
  }

  if (/FROM push_subscriptions/i.test(text)) {
    lastUserId = params[0];
    return {
      rows: [{
        endpoint: 'https://push.example.test/sub',
        p256dh: 'chave-de-teste',
        auth: 'auth-de-teste'
      }]
    };
  }

  if (/^INSERT INTO notification_log/i.test(text)) {
    inserts.push({
      userId: params[0],
      missionId: params[1],
      kind: params[2],
      sentOn: params[3] || null
    });
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`SQL inesperada no teste: ${text}`);
}

function mission(overrides) {
  return {
    id: 10,
    title: 'constancia',
    mode: 'duo',
    started_at: new Date('2026-11-01T15:00:00.000Z'),
    duration_days: 7,
    user_id: 1,
    partner_id: 2,
    user_reminder_time: '23:00',
    user_timezone: 'America/Sao_Paulo',
    partner_reminder_time: '02:00',
    partner_timezone: 'Europe/Lisbon',
    // Lembretes = sim (migração 009); o caso negado fica em
    // test/notification-preferences.test.js.
    user_reminders_on: true,
    partner_reminders_on: true,
    ...overrides
  };
}

function bodiesFor(userId) {
  return pushes.filter((item) => item.userId === userId).map((item) => item.body);
}

describe('dia da missao no fuso da pessoa', { concurrency: 1 }, () => {
  before(() => {
    mock.method(Pool.prototype, 'query', withAuthDb(handleQuery));
    mock.method(webpush, 'sendNotification', async (_subscription, payload) => {
      pushes.push({ userId: lastUserId, ...JSON.parse(payload) });
    });
    ({ runReminderSweep } = require('../routes/notifications'));
  });

  after(() => {
    mock.restoreAll();
  });

  test('perto da meia-noite cada fuso usa o proprio dia', async () => {
    currentMission = mission();
    pushes.length = 0;
    inserts.length = 0;

    await runReminderSweep(new Date('2026-11-08T02:30:00.000Z'));

    assert.deepEqual(bodiesFor(1), [
      'constancia: este e o horario que escolheste. Falta o registo do dia 7.'
    ]);
    assert.deepEqual(bodiesFor(2), []);
    assert.deepEqual(inserts.map((item) => item.userId), [1]);
    assert.equal(inserts[0].sentOn, '2026-11-07');
  });

  test('o ultimo dia ainda avisa e o dia seguinte, no outro fuso, nao', async () => {
    currentMission = mission({
      user_reminder_time: '00:00',
      user_timezone: 'America/Sao_Paulo',
      partner_reminder_time: '12:00',
      partner_timezone: 'Asia/Tokyo'
    });
    pushes.length = 0;
    inserts.length = 0;

    await runReminderSweep(new Date('2026-11-08T03:30:00.000Z'));

    assert.deepEqual(bodiesFor(1), []);
    assert.deepEqual(bodiesFor(2), [
      'constancia: este e o horario que escolheste. Falta o registo do dia 7.'
    ]);
    assert.deepEqual(inserts.map((item) => item.userId), [2]);
    assert.equal(inserts[0].sentOn, '2026-11-08');
  });

  test('sem horario escolhido o dia continua no relogio do servidor', async () => {
    const now = new Date();
    now.setHours(13, 10, 0, 0);
    const started = new Date(now.getTime() - (60 * 60 * 1000));

    currentMission = mission({
      started_at: started,
      duration_days: 30,
      partner_id: null,
      user_reminder_time: null,
      user_timezone: null,
      partner_reminder_time: null,
      partner_timezone: null
    });
    pushes.length = 0;
    inserts.length = 0;

    await runReminderSweep(now);

    assert.equal(bodiesFor(1).length, 1);
    assert.match(bodiesFor(1)[0], /dia 1/);
    assert.equal(inserts[0].kind, 'midday_nudge');
    assert.equal(inserts[0].sentOn, null);
  });
});
