const { describe, test, mock, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const checkinsRouter = require('../routes/checkins');
const { errorHandler } = require('../lib/error-handler');

const app = express();
app.use(express.json());
app.use('/api/checkins', checkinsRouter);
app.use(errorHandler);

// Banco simulado: guarda cada consulta e os parâmetros, e o que foi gravado.
const db = {
  missions: new Map(),
  checkins: [],
  queries: [],
  failInsert: false
};

function resetDb() {
  db.missions.clear();
  db.checkins = [];
  db.queries = [];
  db.failInsert = false;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };

  if (/^INSERT INTO checkins/i.test(text)) {
    if (db.failInsert) throw new Error('falha simulada do banco');
    const row = {
      id: db.checkins.length + 1,
      mission_id: Number(params[0]),
      user_id: Number(params[1]),
      day_number: Number(params[2]),
      completed: true,
      note: params[3],
      is_difficult: params[4] === true
    };
    db.checkins.push(row);
    return { rows: [{ ...row }] };
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

  if (/FROM checkins/i.test(text)) return { rows: [] };
  return { rows: [] };
}

function missionRow(extra = {}) {
  return {
    id: 10,
    user_id: 1,
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

// Tudo o que for escrito no console durante o teste.
let logged = [];
function captureConsole() {
  logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    mock.method(console, method, (...args) => {
      logged.push(args.map(arg => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' '));
    });
  }
}

let server;
let baseUrl;

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

async function post(body, { token = tokenFor(1), raw } = {}) {
  const response = await fetch(`${baseUrl}/api/checkins`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json'
    },
    body: raw != null ? raw : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

// Prova que um texto não ficou em nenhum lugar: banco, consultas e console.
function assertNowhere(fragment) {
  const needle = fragment.toLowerCase();
  for (const row of db.checkins) {
    assert.ok(!String(row.note ?? '').toLowerCase().includes(needle), 'a nota foi gravada');
  }
  for (const query of db.queries) {
    const params = JSON.stringify(query.params ?? []).toLowerCase();
    assert.ok(!params.includes(needle), `a nota foi para o banco: ${query.text}`);
    assert.ok(!query.text.toLowerCase().includes(needle), 'a nota entrou no SQL');
  }
  for (const line of logged) {
    assert.ok(!line.toLowerCase().includes(needle), 'a nota apareceu no log');
  }
}

describe('filtro de crise na rota de check-in', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({
      query: async (sql, params) => handle(sql, params),
      release() {}
    }));
    await new Promise(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    resetDb();
    db.missions.set(10, missionRow());
    captureConsole();
  });

  afterEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      if (console[method].mock) console[method].mock.restore();
    }
  });

  test('ALTO: check-in conta, nota não é gravada nem vai para log', async () => {
    const res = await post({ mission_id: 10, note: 'hoje eu so quero morrer' });

    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(res.body.checkin.completed, true);
    assert.equal(res.body.checkin.note, null);
    assert.equal(res.body.already_done, false);
    assert.equal(db.checkins.length, 1);
    assert.equal(db.checkins[0].note, null);
    assert.ok(db.queries.some(q => /UPDATE missions SET user_score/.test(q.text)), 'o ponto do dia conta');
    assertNowhere('morrer');
    assert.deepEqual(logged, []);
  });

  test('v2 (gatilho + alvo): nota não é gravada nem vai para log', async () => {
    const res = await post({ mission_id: 10, note: 'o dia de hoje me fez querer me matar' });

    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(res.body.checkin.note, null);
    assert.equal(db.checkins[0].note, null);
    assertNowhere('matar');
    assertNowhere('fez querer');
    assert.deepEqual(logged, []);
  });

  test('MÉDIO em dia difícil: conta como dia difícil, sem guardar a nota', async () => {
    const res = await post({ mission_id: 10, difficult: true, minimum_done: true, note: 'nao vejo saida' });

    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'medio');
    assert.equal(res.body.checkin.difficult, true);
    assert.equal(db.checkins[0].is_difficult, true);
    assert.equal(db.checkins[0].note, null);
    assertNowhere('saida');
  });

  test('dia difícil sem confirmar o mínimo: 400, nada gravado, mas o sinal de ajuda vai', async () => {
    const res = await post({ mission_id: 10, difficult: true, note: 'quero morrer' });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /confirme que fez o mínimo/);
    assert.equal(res.body.crisis, true);
    assert.equal(db.checkins.length, 0);
    assertNowhere('morrer');
    assert.deepEqual(logged, []);
  });

  test('dia difícil com frase opcional sem crise: a frase é gravada', async () => {
    const res = await post({ mission_id: 10, difficult: true, minimum_done: true, note: 'dia pesado no trabalho' });

    assert.equal(res.status, 201);
    assert.equal('crisis' in res.body, false);
    assert.equal(db.checkins[0].is_difficult, true);
    assert.equal(db.checkins[0].note, 'dia pesado no trabalho');
  });

  test('crise dispensa a prova escrita da missão (sem penalidade)', async () => {
    db.missions.set(10, missionRow({ proof_mode: 'study_note' }));
    const res = await post({ mission_id: 10, note: 'quero sumir' });

    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(db.checkins[0].note, null);
    assertNowhere('sumir');
  });

  test('sem disparo, nada muda: nota gravada e resposta sem campos de crise', async () => {
    const res = await post({ mission_id: 10, note: 'vou me matar de treinar hoje' });

    assert.equal(res.status, 201);
    assert.equal('crisis' in res.body, false);
    assert.equal('crisis_level' in res.body, false);
    assert.equal(res.body.checkin.note, 'vou me matar de treinar hoje');
    assert.equal(db.checkins[0].note, 'vou me matar de treinar hoje');
  });

  test('sem disparo, a prova curta continua a ser exigida', async () => {
    db.missions.set(10, missionRow({ proof_mode: 'study_note' }));
    const res = await post({ mission_id: 10, note: 'li' });

    assert.equal(res.status, 400);
    assert.equal('crisis' in res.body, false);
    assert.equal(db.checkins.length, 0);
  });

  test('caso negado: sem login não grava nada e não lê a nota', async () => {
    const res = await post({ mission_id: 10, note: 'quero morrer' }, { token: null });

    assert.equal(res.status, 401);
    assert.equal('crisis' in res.body, false);
    assert.equal(db.queries.length, 0);
    assert.equal(db.checkins.length, 0);
    assert.deepEqual(logged, []);
  });

  test('caso negado: outra pessoa recebe 404, nada é gravado, mas vê o sinal de ajuda', async () => {
    const res = await post({ mission_id: 10, note: 'quero morrer' }, { token: tokenFor(7) });

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Missão não encontrada.');
    assert.equal(res.body.crisis, true);
    assert.equal(db.checkins.length, 0);
    assertNowhere('morrer');
  });

  test('erro com crise ainda devolve o sinal (missão inativa)', async () => {
    db.missions.set(10, missionRow({ status: 'completed' }));
    const res = await post({ mission_id: 10, note: 'nao quero mais viver' });

    assert.equal(res.status, 400);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assertNowhere('viver');
  });

  test('falha do banco não escreve a nota em log', async () => {
    db.failInsert = true;
    const res = await post({ mission_id: 10, note: 'quero morrer' });

    assert.equal(res.status, 500);
    assert.equal(res.body.crisis, true);
    assertNowhere('morrer');
    assert.deepEqual(logged, []);
  });

  test('JSON quebrado com nota de crise: o log guarda só o tipo do erro', async () => {
    const res = await post(null, { raw: '{"mission_id": 10, "note": quero morrer}' });

    assert.equal(res.status, 500);
    assert.equal(db.queries.length, 0);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /entity\.parse\.failed/);
    assertNowhere('morrer');
  });
});
