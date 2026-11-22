// Consentimento para guardar a nota do check-in (decisão de 22/11).
// Banco simulado (nada de banco real). A prova com Postgres de verdade
// fica no PR (rodada à mão num banco descartável).
const { describe, test, mock, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const usersRouter = require('../routes/users');
const checkinsRouter = require('../routes/checkins');
const { errorHandler } = require('../lib/error-handler');
const {
  NOTE_CONSENT_VERSION,
  NOTE_CONSENT_SAVE_ERROR,
  NOTE_CONSENT_BODY_ERROR
} = require('../lib/note-consent');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
app.use('/api/checkins', checkinsRouter);
app.use(errorHandler);

// ---------- banco simulado ----------
const db = {
  migrated: true, // migração 007 aplicada?
  users: new Map(),
  missions: new Map(),
  checkins: [],
  queries: [],
  gone: new Set() // contas excluídas (o login recusa)
};

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function missingColumn() {
  const err = new Error('column "note_consent" of relation "users" does not exist');
  err.code = '42703';
  return err;
}

function consentRow(user) {
  if (!db.migrated || user.note_consent == null) {
    return { granted: db.migrated ? false : null, choice: null, decided_at: null, version: null };
  }
  return {
    granted: user.note_consent === true,
    choice: String(user.note_consent),
    decided_at: user.note_consent_at,
    version: user.note_consent_version
  };
}

let clock = 0;
function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };

  if (/to_jsonb\(users\) -> 'note_consent'/.test(text)) {
    const user = db.users.get(Number(params[0]));
    return { rows: user ? [consentRow(user)] : [] };
  }

  if (/^UPDATE users SET note_consent = (TRUE|FALSE)/.test(text)) {
    if (!db.migrated) throw missingColumn();
    const user = db.users.get(Number(params[0]));
    if (!user) return { rows: [], rowCount: 0 };
    user.note_consent = /note_consent = TRUE/.test(text);
    clock += 1;
    user.note_consent_at = new Date(Date.UTC(2026, 10, 22, 17, 0, clock)).toISOString();
    user.note_consent_version = params[1];
    return { rows: [consentRow(user)], rowCount: 1 };
  }

  if (/^UPDATE checkins SET note = NULL WHERE user_id = \$1 AND note IS NOT NULL$/.test(text)) {
    let count = 0;
    for (const row of db.checkins) {
      if (row.user_id === Number(params[0]) && row.note != null) {
        row.note = null;
        count += 1;
      }
    }
    return { rows: [], rowCount: count };
  }

  if (/^INSERT INTO checkins/i.test(text)) {
    const key = (row) => `${row.mission_id}:${row.user_id}:${row.day_number}`;
    const incoming = {
      id: db.checkins.length + 1,
      mission_id: Number(params[0]),
      user_id: Number(params[1]),
      day_number: Number(params[2]),
      completed: true,
      note: params[3],
      is_difficult: params[4] === true
    };
    const existing = db.checkins.find((row) => key(row) === key(incoming));
    if (existing) {
      // Igual ao SQL: CASE WHEN $6 THEN NULL ELSE COALESCE($4, checkins.note) END
      existing.note = params[5] === true ? null : (incoming.note ?? existing.note ?? null);
      return { rows: [{ ...existing }] };
    }
    db.checkins.push(incoming);
    return { rows: [{ ...incoming }] };
  }

  if (/^UPDATE/i.test(text)) return { rows: [], rowCount: 1 };
  if (/FROM users/i.test(text)) return { rows: [{ reminder_time: null, timezone: null }] };
  if (/FROM mission_matches/i.test(text)) return { rows: [] };

  if (/FROM missions/i.test(text)) {
    const mission = db.missions.get(Number(params[0]));
    if (!mission) return { rows: [] };
    if (params.length >= 2) {
      const who = Number(params[1]);
      const member = Number(mission.user_id) === who
        || (mission.partner_id != null && Number(mission.partner_id) === who);
      if (!member) return { rows: [] };
    }
    return { rows: [{ ...mission }] };
  }

  if (/FROM checkins/i.test(text)) {
    // Existe linha do dia? (alreadyDone). O resto (conclusão) não importa aqui.
    if (/day_number = \$3/.test(text)) {
      const found = db.checkins.filter((row) => row.mission_id === Number(params[0])
        && row.user_id === Number(params[1]) && row.day_number === Number(params[2]));
      return { rows: found.map((row) => ({ completed: row.completed })) };
    }
    return { rows: [] };
  }
  return { rows: [] };
}

function resetDb() {
  db.migrated = true;
  db.users = new Map([
    [1, { id: 1, note_consent: null }],
    [2, { id: 2, note_consent: null }],
    [3, { id: 3, note_consent: null }]
  ]);
  db.missions = new Map([
    // Começou há 2 dias: hoje é o Dia 3 (os dias 1 e 2 podem ter nota antiga).
    [10, missionRow({ id: 10, user_id: 1, started_at: new Date(Date.now() - 2 * 86400000 - 60000).toISOString() })],
    [11, missionRow({ id: 11, user_id: 1, proof_mode: 'study_note' })],
    [20, missionRow({ id: 20, user_id: 2 })]
  ]);
  db.checkins = [];
  db.queries = [];
  db.gone = new Set();
}

function missionRow(extra = {}) {
  return {
    partner_id: null,
    status: 'active',
    mode: 'solo',
    proof_mode: 'self_report',
    started_at: new Date(Date.now() - 60 * 1000).toISOString(),
    duration_days: 30,
    user_score: 0,
    partner_score: 0,
    ...extra
  };
}

function storedNotes(userId) {
  return db.checkins.filter((row) => row.user_id === userId).map((row) => row.note);
}

// Notas que já estavam no banco (ex.: guardadas com o "sim").
function seedNote(userId, missionId, day, note) {
  db.checkins.push({
    id: db.checkins.length + 1,
    mission_id: missionId,
    user_id: userId,
    day_number: day,
    completed: true,
    note,
    is_difficult: false
  });
}

// ---------- console ----------
let logged = [];
function captureConsole() {
  logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    mock.method(console, method, (...args) => {
      logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' '));
    });
  }
}

// ---------- pedidos ----------
let server;
let baseUrl;

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

async function call(method, url, { body, token = tokenFor(1) } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const consent = {
  read: (opts) => call('GET', '/api/users/me/note-consent', opts),
  give: (opts) => call('POST', '/api/users/me/note-consent', { body: { consent: true }, ...opts }),
  withdraw: (opts) => call('DELETE', '/api/users/me/note-consent', opts)
};

function checkin(body, opts) {
  return call('POST', '/api/checkins', { body, ...opts });
}

function assertNowhere(fragment) {
  const needle = fragment.toLowerCase();
  for (const row of db.checkins) {
    assert.ok(!String(row.note ?? '').toLowerCase().includes(needle), 'a nota foi gravada');
  }
  for (const query of db.queries) {
    assert.ok(!JSON.stringify(query.params ?? []).toLowerCase().includes(needle), `a nota foi para o banco: ${query.text}`);
  }
  for (const line of logged) {
    assert.ok(!line.toLowerCase().includes(needle), 'a nota foi para o log');
  }
}

const NOTA = 'li vinte paginas do livro';

describe('consentimento da nota do check-in', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params), {
      missing: (id) => db.gone.has(id)
    }));
    mock.method(Pool.prototype, 'connect', async () => ({
      query: async (sql, params) => handle(sql, params),
      release() {}
    }));
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
    captureConsole();
  });

  afterEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      if (console[method].mock) console[method].mock.restore();
    }
  });

  // ---------- rotas da escolha ----------
  test('sem resposta: a escolha é null (vale "não") e ninguém começa com sim', async () => {
    const res = await consent.read();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { note_consent: null, decided_at: null, version: null });
  });

  test('dar o consentimento grava sim, a hora do servidor e a versão do texto', async () => {
    const res = await consent.give();
    assert.equal(res.status, 200);
    assert.equal(res.body.note_consent, 'yes');
    assert.equal(res.body.version, NOTE_CONSENT_VERSION);
    assert.ok(!Number.isNaN(Date.parse(res.body.decided_at)));
    assert.equal(db.users.get(1).note_consent, true);

    const read = await consent.read();
    assert.deepEqual(read.body, res.body);
  });

  test('só { consent: true } vale como sim (corpo vazio, "true" em texto, false: 400)', async () => {
    for (const body of [{}, { consent: 'true' }, { consent: 1 }, { consent: false }, { yes: true }]) {
      const res = await call('POST', '/api/users/me/note-consent', { body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, NOTE_CONSENT_BODY_ERROR);
      assert.equal(res.body.code, 'consent_required');
    }
    assert.equal(db.users.get(1).note_consent, null);
  });

  test('«Não guardar» na primeira pergunta grava não com a hora (a pergunta não volta)', async () => {
    const res = await consent.withdraw();
    assert.equal(res.status, 200);
    assert.equal(res.body.note_consent, 'no');
    assert.ok(res.body.decided_at);
    assert.equal(res.body.notes_deleted, 0);
    assert.equal(db.users.get(1).note_consent, false);
  });

  test('401 sem login nas três rotas e nada muda', async () => {
    for (const fn of [consent.read, consent.give, consent.withdraw]) {
      const res = await fn({ token: null });
      assert.equal(res.status, 401);
    }
    assert.equal(db.users.get(1).note_consent, null);
  });

  test('conta excluída (token antigo): 401 e nada muda', async () => {
    seedNote(3, 10, 1, 'nota antiga');
    db.gone.add(3);
    for (const fn of [consent.read, consent.give, consent.withdraw]) {
      const res = await fn({ token: tokenFor(3) });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'session_ended');
    }
    assert.equal(db.users.get(3).note_consent, null);
    assert.deepEqual(storedNotes(3), ['nota antiga']);
  });

  test('outra pessoa não muda a sua escolha nem apaga as suas notas', async () => {
    await consent.give();
    seedNote(1, 10, 1, 'nota da pessoa 1');
    seedNote(2, 20, 1, 'nota da pessoa 2');
    db.queries = [];

    const other = await consent.withdraw({ token: tokenFor(2) });
    assert.equal(other.status, 200);
    assert.equal(other.body.notes_deleted, 1);

    assert.equal(db.users.get(1).note_consent, true);
    assert.deepEqual(storedNotes(1), ['nota da pessoa 1']);
    assert.deepEqual(storedNotes(2), [null]);
    const mine = await consent.read();
    assert.equal(mine.body.note_consent, 'yes');
    // O id vem só do token: nenhum parâmetro do pedido escolhe a pessoa.
    const changes = db.queries.filter((q) => /^UPDATE (users|checkins)/.test(q.text));
    assert.ok(changes.every((q) => Number(q.params[0]) === 2));
  });

  // ---------- check-in ----------
  test('sem consentimento: check-in OK, nota NULL no banco e note_saved false', async () => {
    const res = await checkin({ mission_id: 10, note: NOTA });
    assert.equal(res.status, 201);
    assert.equal(res.body.note_saved, false);
    assert.equal(res.body.checkin.note, null);
    assert.equal(res.body.crisis, undefined);
    assert.deepEqual(storedNotes(1), [null]);
    assertNowhere(NOTA);
  });

  test('com "não" gravado: a nota também não é gravada', async () => {
    await consent.withdraw();
    const res = await checkin({ mission_id: 10, note: NOTA });
    assert.equal(res.status, 201);
    assert.equal(res.body.note_saved, false);
    assert.deepEqual(storedNotes(1), [null]);
    assertNowhere(NOTA);
  });

  test('nota antiga no dia, sem consentimento, check-in de novo: a nota do dia vira NULL', async () => {
    seedNote(1, 10, 3, 'nota antiga do dia');
    const res = await checkin({ mission_id: 10, note: NOTA });
    assert.equal(res.status, 201);
    assert.equal(res.body.already_done, true);
    assert.equal(res.body.note_saved, false);
    assert.equal(res.body.checkin.note, null);
    assert.deepEqual(storedNotes(1), [null]);

    // Também sem frase nova (ex.: dia difícil sem frase) e com "não" gravado.
    seedNote(1, 11, 1, 'outra nota antiga');
    await consent.withdraw();
    db.checkins.find((row) => row.mission_id === 11).note = 'outra nota antiga';
    const again = await checkin({ mission_id: 11, note: 'estudei a regra de tres hoje' });
    assert.equal(again.status, 201);
    assert.ok(storedNotes(1).every((note) => note === null));
  });

  test('com consentimento e sem frase nova: a nota do dia fica (como antes)', async () => {
    await consent.give();
    seedNote(1, 10, 3, 'nota guardada com o sim');
    const res = await checkin({ mission_id: 10, difficult: true, minimum_done: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.note_saved, false);
    assert.deepEqual(storedNotes(1), ['nota guardada com o sim']);
  });

  test('com consentimento: a nota é gravada e note_saved true', async () => {
    await consent.give();
    const res = await checkin({ mission_id: 10, note: NOTA });
    assert.equal(res.status, 201);
    assert.equal(res.body.note_saved, true);
    assert.equal(res.body.checkin.note, NOTA);
    assert.deepEqual(storedNotes(1), [NOTA]);
  });

  test('com consentimento e sem nota: note_saved false', async () => {
    await consent.give();
    const res = await checkin({ mission_id: 10 });
    assert.equal(res.status, 201);
    assert.equal(res.body.note_saved, false);
  });

  test('o consentimento é lido no servidor: um "note_consent" no pedido não vale', async () => {
    const res = await checkin({ mission_id: 10, note: NOTA, note_consent: true, consent: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.note_saved, false);
    assert.deepEqual(storedNotes(1), [null]);
  });

  test('o consentimento de outra pessoa não vale para você', async () => {
    await consent.give({ token: tokenFor(2) });
    const res = await checkin({ mission_id: 10, note: NOTA });
    assert.equal(res.body.note_saved, false);
    assert.deepEqual(storedNotes(1), [null]);
  });

  test('retirar: apaga as notas guardadas e as próximas não são gravadas', async () => {
    await consent.give();
    seedNote(1, 10, 1, 'nota do dia um');
    seedNote(1, 10, 2, 'nota do dia dois');
    await checkin({ mission_id: 10, note: NOTA });
    assert.equal(storedNotes(1).filter(Boolean).length, 3);

    const res = await consent.withdraw();
    assert.equal(res.status, 200);
    assert.equal(res.body.note_consent, 'no');
    assert.equal(res.body.notes_deleted, 3);
    assert.equal(db.users.get(1).note_consent, false);
    // Os dias continuam registrados, só sem a nota.
    assert.equal(db.checkins.filter((row) => row.user_id === 1).length, 3);
    assert.ok(storedNotes(1).every((note) => note === null));

    const next = await checkin({ mission_id: 11, note: 'estudei a regra de tres hoje' });
    assert.equal(next.status, 201);
    assert.equal(next.body.note_saved, false);
    assert.ok(storedNotes(1).every((note) => note === null));
    assertNowhere('regra de tres');
  });

  test('o check-in lê a escolha com a linha da pessoa travada, antes da trava da missão', async () => {
    await checkin({ mission_id: 10, note: NOTA });
    const texts = db.queries.map((q) => q.text);
    const begin = texts.indexOf('BEGIN');
    const read = texts.findIndex((t) => /note_consent/.test(t) && /FOR SHARE$/.test(t));
    const missionLock = texts.findIndex((t) => /FROM missions/.test(t) && /FOR UPDATE/.test(t));
    assert.ok(begin >= 0 && read > begin && missionLock > read, texts.join('\n'));
  });

  test('crise sem consentimento: crisis true, check-in feito e nada gravado nem logado', async () => {
    const frase = 'hoje eu quero me matar';
    const res = await checkin({ mission_id: 10, note: frase });
    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.note_saved, false);
    assert.deepEqual(storedNotes(1), [null]);
    assertNowhere('quero me matar');
  });

  test('crise com consentimento: crisis true e nada gravado (regra de antes)', async () => {
    await consent.give();
    const frase = 'hoje eu quero me matar';
    const res = await checkin({ mission_id: 10, note: frase });
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.note_saved, false);
    assert.deepEqual(storedNotes(1), [null]);
    assertNowhere('quero me matar');
  });

  test('missão com prova escrita, sem consentimento: o texto valida a prova e não é gravado', async () => {
    const short = await checkin({ mission_id: 11, note: 'pouco' });
    assert.equal(short.status, 400);
    assert.equal(db.checkins.length, 0);

    const ok = await checkin({ mission_id: 11, note: 'estudei a regra de tres hoje' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.note_saved, false);
    assert.deepEqual(storedNotes(1), [null]);
  });

  // ---------- antes da migração 007 ----------
  test('sem a migração 007: check-in não grava a nota; dar ou retirar respondem 503 sem log', async () => {
    db.migrated = false;
    const res = await checkin({ mission_id: 10, note: NOTA });
    assert.equal(res.status, 201);
    assert.equal(res.body.note_saved, false);
    assert.deepEqual(storedNotes(1), [null]);

    const read = await consent.read();
    assert.equal(read.status, 200);
    assert.equal(read.body.note_consent, null);

    for (const fn of [consent.give, consent.withdraw]) {
      const changed = await fn();
      assert.equal(changed.status, 503);
      assert.equal(changed.body.error, NOTE_CONSENT_SAVE_ERROR);
      assert.equal(changed.body.code, 'consent_unavailable');
    }
    assert.deepEqual(logged, []);
  });
});

// ---------- migração ----------
test('007: só acrescenta, ninguém começa com sim, registra a versão e explica a volta', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '007_user_note_consent.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.match(code, /ADD COLUMN IF NOT EXISTS note_consent BOOLEAN,/);
  assert.doesNotMatch(code, /DEFAULT/i);
  assert.match(code, /ADD COLUMN IF NOT EXISTS note_consent_at TIMESTAMPTZ/);
  assert.match(code, /CHECK \(note_consent IS NULL OR note_consent_at IS NOT NULL\)/);
  assert.match(code, /'007_user_note_consent'/);
  assert.match(code, /^BEGIN;/m);
  assert.match(code, /^COMMIT;/m);
  assert.match(sql, /Para voltar atrás/);
});
