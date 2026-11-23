// Lembretes separados das novidades (decisão de 22/11). Banco simulado e
// web-push interceptado: nada sai da máquina, nada de banco real.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const webpush = require('web-push');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

const usersRouter = require('../routes/users');
const verticeRouter = require('../routes/vertice');
const { sendNotification, runReminderSweep } = require('../routes/notifications');
const {
  NOTIFICATION_CHOICE_VERSION,
  PREFS_BODY_ERROR,
  PREFS_SAVE_ERROR
} = require('../lib/notification-preferences');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
app.use('/api/vertice', verticeRouter);

const SECRET = 'segredo-das-novidades-de-teste';

// ---------- banco simulado ----------
// users: id -> { reminders_opt_in, news_opt_in, ... } (undefined = sem a 009)
const db = { migrated: true, users: new Map(), queries: [], pushes: [], logInserts: [], missions: [], gone: new Set() };

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function missingColumn() {
  const err = new Error('column "reminders_opt_in" of relation "users" does not exist');
  err.code = '42703';
  return err;
}

// Mesma regra do SQL (lib/notification-preferences.js), para o simulador.
function remindersOn(user) {
  if (!db.migrated) return true; // sem a coluna: como antes
  return user.reminders_opt_in === true;
}
function newsOn(user) {
  if (!db.migrated) return false; // sem a coluna: nunca
  return user.news_opt_in === true;
}

function prefsRow(user) {
  const v = (x) => (db.migrated && x != null ? String(x) : null);
  return {
    reminders: v(user.reminders_opt_in),
    reminders_at: db.migrated ? (user.reminders_opt_in_at ?? null) : null,
    news: v(user.news_opt_in),
    news_at: db.migrated ? (user.news_opt_in_at ?? null) : null
  };
}

let tick = 0;
function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^SELECT to_jsonb\(users\) ->> 'reminders_opt_in' AS reminders/.test(text)) {
    const user = db.users.get(Number(params[0]));
    return { rows: user ? [prefsRow(user)] : [] };
  }

  if (/^UPDATE users SET (reminders_opt_in|news_opt_in) = /.test(text)) {
    if (!db.migrated) throw missingColumn();
    const user = db.users.get(Number(params[0]));
    if (!user) return { rows: [], rowCount: 0 };
    tick += 1;
    const at = new Date(Date.UTC(2026, 10, 22, 19, 0, tick)).toISOString();
    for (const column of ['reminders_opt_in', 'news_opt_in']) {
      const m = new RegExp(`${column} = \\$(\\d+), ${column}_at = NOW\\(\\), ${column}_version = \\$2`).exec(text);
      if (m) {
        user[column] = params[Number(m[1]) - 1];
        user[`${column}_at`] = at;
        user[`${column}_version`] = params[1];
      }
    }
    return { rows: [prefsRow(user)], rowCount: 1 };
  }

  // Inscrições de push com o filtro da escolha (sendNotification).
  if (/FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE ps.user_id = \$1/.test(text)) {
    const user = db.users.get(Number(params[0]));
    if (!user || !user.subscribed) return { rows: [] };
    const news = /news_opt_in/.test(text);
    const mission = /reminders_opt_in/.test(text);
    assert.ok(news !== mission, 'cada envio usa um filtro só');
    const ok = news ? newsOn(user) : remindersOn(user);
    return { rows: ok ? [{ endpoint: `https://push.example.test/${user.id}`, p256dh: 'k', auth: 'a' }] : [] };
  }

  // Destinatários das novidades (notify-all).
  if (/^SELECT u.id FROM users u WHERE/.test(text)) {
    assert.match(text, /news_opt_in/);
    assert.doesNotMatch(text, /reminders_opt_in/);
    const rows = [...db.users.values()].filter((u) => newsOn(u) && u.subscribed).map((u) => ({ id: u.id }));
    return { rows };
  }

  // Motor de lembretes.
  if (/FROM missions m/i.test(text)) {
    assert.match(text, /AS user_reminders_on/);
    assert.match(text, /AS partner_reminders_on/);
    return {
      rows: db.missions.map((m) => ({
        ...m,
        user_reminders_on: remindersOn(db.users.get(m.user_id)),
        partner_reminders_on: m.partner_id ? remindersOn(db.users.get(m.partner_id)) : null
      }))
    };
  }
  if (/FROM checkins/i.test(text)) return { rows: [] };
  if (/created_at AT TIME ZONE/i.test(text)) return { rows: [] };
  if (/FROM notification_log/i.test(text)) return { rows: [] };
  if (/^INSERT INTO notification_log/i.test(text)) {
    db.logInserts.push({ userId: Number(params[0]), kind: params[2] });
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`SQL inesperada no teste: ${text}`);
}

function resetDb() {
  db.migrated = true;
  db.users = new Map([
    [1, { id: 1, subscribed: true }],
    [2, { id: 2, subscribed: true }],
    [3, { id: 3, subscribed: true }]
  ]);
  db.queries = [];
  db.pushes = [];
  db.logInserts = [];
  db.missions = [];
  db.gone = new Set();
}

// ---------- pedidos ----------
let server;
let baseUrl;
let logged = [];

function tokenFor(id) {
  return jwt.sign({ userId: id }, process.env.JWT_SECRET);
}

async function call(method, url, { body, token = tokenFor(1), headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
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

const prefs = {
  read: (opts) => call('GET', '/api/users/me/notification-preferences', opts),
  set: (body, opts) => call('PUT', '/api/users/me/notification-preferences', { body, ...opts })
};

function news(body, headers = { 'x-vertice-secret': SECRET }) {
  return call('POST', '/api/vertice/notify-all', { body, headers, token: null });
}

const NEWS = { title: 'Novidade de teste', body: 'Um texto de novidade, igual para todos.' };

// Sem horário escolhido (relógio do servidor): às 13:10, com a missão
// começada há 1 hora, sai o aviso do meio-dia (como em reminder-sweep.test.js).
function sweepNow() {
  const now = new Date();
  now.setHours(13, 10, 0, 0);
  return now;
}

function missionRow(extra = {}) {
  return {
    id: 10, title: 'missao de teste', mode: 'solo',
    started_at: new Date(sweepNow().getTime() - 60 * 60 * 1000), duration_days: 30,
    mission_weekdays: null, user_id: 1, partner_id: null,
    user_reminder_time: null, user_timezone: null,
    partner_reminder_time: null, partner_timezone: null,
    ...extra
  };
}

describe('lembretes separados das novidades', { concurrency: 1 }, () => {
  before(async () => {
    process.env.VERTICE_SECRET = SECRET;
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params), {
      missing: (id) => db.gone.has(id)
    }));
    mock.method(webpush, 'sendNotification', async (subscription, payload) => {
      db.pushes.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
    });
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      mock.method(console, method, (...args) => { logged.push(args.join(' ')); });
    }
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetDb();
    logged = [];
  });

  // ---------- rotas ----------
  test('nenhuma nasce ligada: as três começam sem escolha (null)', async () => {
    const res = await prefs.read();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      reminders: { choice: null, decided_at: null },
      news: { choice: null, decided_at: null },
      messages: { choice: null, decided_at: null }
    });
  });

  test('cada escolha muda sozinha, com a hora do servidor e a versão do texto', async () => {
    const one = await prefs.set({ reminders: true });
    assert.equal(one.status, 200);
    assert.equal(one.body.reminders.choice, 'yes');
    assert.ok(Date.parse(one.body.reminders.decided_at));
    assert.deepEqual(one.body.news, { choice: null, decided_at: null });
    assert.equal(db.users.get(1).reminders_opt_in_version, NOTIFICATION_CHOICE_VERSION);

    const two = await prefs.set({ news: false });
    assert.equal(two.body.reminders.choice, 'yes', 'lembretes não mudam');
    assert.equal(two.body.news.choice, 'no');

    const both = await prefs.set({ reminders: false, news: true });
    assert.equal(both.body.reminders.choice, 'no');
    assert.equal(both.body.news.choice, 'yes');
    assert.deepEqual((await prefs.read()).body, both.body);
  });

  test('negado: corpo inválido → 400 e nada muda', async () => {
    for (const body of [{}, { reminders: 'true' }, { news: 1 }, { reminders: null }, { marketing: true }, { reminders: true, extra: true }, [true]]) {
      const res = await prefs.set(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, PREFS_BODY_ERROR);
      assert.equal(res.body.code, 'preferences_invalid');
    }
    assert.equal(db.users.get(1).reminders_opt_in, undefined);
    assert.ok(!db.queries.some((q) => /^UPDATE users/.test(q.text)));
  });

  test('negado: 401 sem login nas duas rotas, e para conta excluída', async () => {
    assert.equal((await prefs.read({ token: null })).status, 401);
    assert.equal((await prefs.set({ news: true }, { token: null })).status, 401);
    db.gone.add(1);
    const gone = await prefs.set({ news: true });
    assert.equal(gone.status, 401);
    assert.equal(gone.body.code, 'session_ended');
    assert.equal(db.users.get(1).news_opt_in, undefined);
  });

  test('outra pessoa não muda a sua escolha (nem com user_id no corpo, que dá 400)', async () => {
    await prefs.set({ reminders: true });
    const withId = await prefs.set({ reminders: false, user_id: 1 }, { token: tokenFor(2) });
    assert.equal(withId.status, 400);
    const other = await prefs.set({ reminders: false, news: true }, { token: tokenFor(2) });
    assert.equal(other.status, 200);
    assert.equal(db.users.get(1).reminders_opt_in, true);
    assert.equal(db.users.get(1).news_opt_in, undefined);
    const updates = db.queries.filter((q) => /^UPDATE users/.test(q.text));
    assert.ok(updates.slice(1).every((q) => Number(q.params[0]) === 2));
  });

  test('sem a migração 009: ler dá null nas duas; mudar dá 503 calmo sem log', async () => {
    db.migrated = false;
    const read = await prefs.read();
    assert.equal(read.body.reminders.choice, null);
    const res = await prefs.set({ news: true });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, PREFS_SAVE_ERROR);
    assert.equal(res.body.code, 'preferences_unavailable');
    assert.deepEqual(logged, []);
  });

  // ---------- envio ----------
  test('sendNotification: lembrete só com lembretes = sim; novidade só com novidades = sim', async () => {
    db.users.get(1).reminders_opt_in = true;
    db.users.get(2).news_opt_in = true;
    assert.equal(await sendNotification(1, 't', 'b'), 1);
    assert.equal(await sendNotification(2, 't', 'b'), 0, 'novidades = sim não libera lembrete');
    assert.equal(await sendNotification(1, 't', 'b', undefined, { kind: 'news' }), 0, 'lembretes = sim não libera novidade');
    assert.equal(await sendNotification(2, 't', 'b', undefined, { kind: 'news' }), 1);
    assert.equal(await sendNotification(3, 't', 'b'), 0, 'sem escolha: nada');
    assert.equal(db.pushes.length, 2);
  });

  test('sendNotification com tipo desconhecido não manda nada', async () => {
    db.users.get(1).reminders_opt_in = true;
    await assert.rejects(() => sendNotification(1, 't', 'b', undefined, { kind: 'marketing' }));
    assert.equal(db.pushes.length, 0);
  });

  test('negado: lembretes = não, o motor não manda nem marca como enviado', async () => {
    db.users.get(1).reminders_opt_in = false;
    db.missions = [missionRow()];
    await runReminderSweep(sweepNow());
    assert.equal(db.pushes.length, 0);
    assert.equal(db.logInserts.length, 0);
  });

  test('lembretes = sim: o motor manda (mesmo caso)', async () => {
    db.users.get(1).reminders_opt_in = true;
    db.missions = [missionRow()];
    await runReminderSweep(sweepNow());
    assert.ok(db.pushes.length >= 1);
    assert.ok(db.logInserts.every((item) => item.userId === 1));
  });

  test('Duo: só quem tem lembretes = sim recebe', async () => {
    db.users.get(1).reminders_opt_in = true;
    db.users.get(2).reminders_opt_in = false;
    db.missions = [missionRow({ mode: 'duo', partner_id: 2 })];
    await runReminderSweep(sweepNow());
    assert.ok(db.pushes.length >= 1);
    assert.ok(db.pushes.every((p) => p.endpoint.endsWith('/1')));
  });

  test('sem a migração 009: o motor manda como antes (quem tem push no aparelho)', async () => {
    db.migrated = false;
    db.missions = [missionRow()];
    await runReminderSweep(sweepNow());
    assert.ok(db.pushes.length >= 1);
  });

  // ---------- notify-all ----------
  test('negado: sem novidades = sim, o notify-all não manda a ninguém', async () => {
    db.users.get(1).reminders_opt_in = true;
    db.users.get(2).news_opt_in = false;
    const res = await news(NEWS);
    assert.equal(res.status, 200);
    assert.equal(res.body.notifications_sent, 0);
    assert.equal(db.pushes.length, 0);
  });

  test('notify-all manda só a quem tem novidades = sim, com o texto da novidade', async () => {
    db.users.get(2).news_opt_in = true;
    db.users.get(3).news_opt_in = true;
    db.users.get(3).subscribed = false;
    const res = await news(NEWS);
    assert.equal(res.status, 200);
    assert.equal(res.body.notifications_sent, 1);
    assert.deepEqual(db.pushes.map((p) => [p.endpoint, p.title, p.body]), [
      ['https://push.example.test/2', NEWS.title, NEWS.body]
    ]);
    assert.ok(!logged.some((line) => line.includes(NEWS.body)));
  });

  test('negado: notify-all sem o texto da novidade (ou grande demais) → 400 e nada sai', async () => {
    db.users.get(2).news_opt_in = true;
    for (const body of [undefined, {}, { title: 'só título' }, { title: ' ', body: 'x' },
      { title: 'x'.repeat(81), body: 'x' }, { title: 'x', body: 'x'.repeat(281) }, { title: 1, body: 2 }]) {
      const res = await news(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'news_content_required');
    }
    assert.equal(db.pushes.length, 0);
  });

  test('negado: notify-all sem a chave → 401 e nada sai', async () => {
    db.users.get(2).news_opt_in = true;
    const res = await news(NEWS, { 'x-vertice-secret': 'errada' });
    assert.equal(res.status, 401);
    assert.equal(db.pushes.length, 0);
  });

  test('sem a migração 009: nenhuma novidade sai', async () => {
    db.migrated = false;
    const res = await news(NEWS);
    assert.equal(res.status, 200);
    assert.equal(res.body.notifications_sent, 0);
    assert.equal(db.pushes.length, 0);
  });
});

// ---------- migração ----------
test('009: só acrescenta, sem default, registra a versão e explica a volta', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '009_user_notification_choices.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(code, /DEFAULT/i);
  for (const col of ['reminders_opt_in BOOLEAN', 'reminders_opt_in_at TIMESTAMPTZ', 'news_opt_in BOOLEAN', 'news_opt_in_at TIMESTAMPTZ']) {
    assert.ok(code.includes(`ADD COLUMN IF NOT EXISTS ${col}`), col);
  }
  assert.match(code, /CHECK \(reminders_opt_in IS NULL OR reminders_opt_in_at IS NOT NULL\)/);
  assert.match(code, /CHECK \(news_opt_in IS NULL OR news_opt_in_at IS NOT NULL\)/);
  assert.match(code, /'009_user_notification_choices'/);
  assert.match(sql, /Para voltar atrás/);
});

test('SQL das novidades não tem a saída "sem coluna = como antes" (só a dos lembretes tem)', () => {
  const { newsAllowedSql, remindersAllowedSql } = require('../lib/notification-preferences');
  assert.equal(normalize(newsAllowedSql('u')), "((to_jsonb(u) -> 'news_opt_in') = 'true'::jsonb)");
  assert.match(normalize(remindersAllowedSql('u')), /^\(NOT \(to_jsonb\(u\) \? 'reminders_opt_in'\) OR/);
  assert.throws(() => newsAllowedSql('u; DROP'));
});
