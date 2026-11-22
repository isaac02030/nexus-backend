// Lembrete pula os dias livres (fora dos dias da missão), na data local da pessoa.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');
const { startWeekdayFor, weekdayForDay } = require('../lib/mission-days');

const pushes = [];
const inserts = [];
let currentMission = null;
let lastUserId = null;
let missionSql = '';
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
    missionSql = text;
    return { rows: currentMission ? [currentMission] : [] };
  }
  if (/FROM checkins/i.test(text) && /day_number IN/i.test(text)) return { rows: [] };
  if (/created_at AT TIME ZONE/i.test(text)) return { rows: [] };
  if (/FROM notification_log/i.test(text)) return { rows: [] };
  if (/FROM push_subscriptions/i.test(text)) {
    lastUserId = params[0];
    return { rows: [{ endpoint: 'https://push.example.test/sub', p256dh: 'chave-de-teste', auth: 'auth-de-teste' }] };
  }
  if (/^INSERT INTO notification_log/i.test(text)) {
    inserts.push({ userId: params[0], kind: params[2], sentOn: params[3] || null });
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`SQL inesperada no teste: ${text}`);
}

// Dia 1: domingo, 01/11/2026 em São Paulo. 02:30 UTC de 08/11 = 23:30 de
// sábado (Dia 7) em São Paulo, depois do lembrete das 23:00.
function mission(overrides) {
  return {
    id: 10,
    title: 'constancia',
    mode: 'solo',
    started_at: new Date('2026-11-01T15:00:00.000Z'),
    duration_days: 30,
    user_id: 1,
    partner_id: null,
    user_reminder_time: '23:00',
    user_timezone: 'America/Sao_Paulo',
    partner_reminder_time: null,
    partner_timezone: null,
    mission_weekdays: null,
    ...overrides
  };
}

function reset() {
  pushes.length = 0;
  inserts.length = 0;
}

describe('lembrete e dias livres', { concurrency: 1 }, () => {
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

  test('a consulta lê os dias da missão sem depender da migração', async () => {
    currentMission = mission();
    reset();
    await runReminderSweep(new Date('2026-11-08T02:30:00.000Z'));
    assert.match(missionSql, /to_jsonb\(m\) -> 'mission_weekdays' AS mission_weekdays/);
  });

  test('sábado livre: nenhum lembrete, nem o principal', async () => {
    currentMission = mission({ mission_weekdays: [1, 2, 3, 4, 5] });
    reset();
    await runReminderSweep(new Date('2026-11-08T02:30:00.000Z'));
    assert.equal(pushes.length, 0);
    assert.equal(inserts.length, 0);
  });

  test('sábado é dia da missão: o lembrete sai', async () => {
    currentMission = mission({ mission_weekdays: [1, 3, 6] });
    reset();
    await runReminderSweep(new Date('2026-11-08T02:30:00.000Z'));
    assert.equal(pushes.length, 1);
    assert.match(pushes[0].body, /dia 7/);
    assert.equal(inserts[0].sentOn, '2026-11-07');
  });

  test('extras também ficam de fora num dia livre', async () => {
    // 16:05 UTC de sábado = 13:05 em São Paulo, hora do extra do meio-dia.
    currentMission = mission({ mission_weekdays: [1, 2, 3, 4, 5] });
    reset();
    await runReminderSweep(new Date('2026-11-07T16:05:00.000Z'));
    assert.equal(pushes.length, 0);

    currentMission = mission({ mission_weekdays: null });
    reset();
    await runReminderSweep(new Date('2026-11-07T16:05:00.000Z'));
    assert.deepEqual(inserts.map(item => item.kind), ['extra_midday']);
  });

  test('ontem livre não vira aviso de "ontem falhou"', async () => {
    const now = new Date();
    now.setHours(13, 10, 0, 0);
    const started = new Date(now.getTime() - 24 * 60 * 60 * 1000 - 60 * 60 * 1000);
    const start = startWeekdayFor(started, null);
    const freeYesterday = [1, 2, 3, 4, 5, 6, 7].filter(day => day !== weekdayForDay(start, 1));
    const legacy = {
      started_at: started,
      user_reminder_time: null,
      user_timezone: null
    };

    currentMission = mission({ ...legacy, mission_weekdays: freeYesterday });
    reset();
    await runReminderSweep(now);
    assert.deepEqual(inserts.map(item => item.kind), ['midday_nudge']);

    currentMission = mission({ ...legacy, mission_weekdays: null });
    reset();
    await runReminderSweep(now);
    assert.deepEqual(inserts.map(item => item.kind), ['midday_recovery']);
  });
});
