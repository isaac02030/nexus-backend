const { describe, test, mock, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');

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

const {
  NOTE_MAX_CHARS,
  NOTE_TOO_LONG_MESSAGE,
  NOTE_NOT_TEXT_MESSAGE,
  noteLength,
  validateNoteLimit
} = require('../lib/note-limit');

describe('limite da frase: contagem', () => {
  test('o limite é 280', () => {
    assert.equal(NOTE_MAX_CHARS, 280);
  });

  test('conta caracteres reais, não bytes nem unidades UTF-16', () => {
    assert.equal(noteLength('ação'), 4);
    assert.equal(noteLength('💪'), 1);
    assert.equal(Buffer.byteLength('💪'), 4);
    assert.equal('💪'.length, 2);
  });

  test('sem nota, 280 e 280 emojis passam; 281 não', () => {
    assert.equal(validateNoteLimit(undefined), null);
    assert.equal(validateNoteLimit(null), null);
    assert.equal(validateNoteLimit(''), null);
    assert.equal(validateNoteLimit('a'.repeat(280)), null);
    assert.equal(validateNoteLimit('💪'.repeat(280)), null);
    assert.equal(validateNoteLimit('ã'.repeat(280)), null);
    assert.equal(validateNoteLimit('a'.repeat(281)), NOTE_TOO_LONG_MESSAGE);
    assert.equal(validateNoteLimit('💪'.repeat(281)), NOTE_TOO_LONG_MESSAGE);
  });

  test('nota que não é texto é recusada', () => {
    assert.equal(validateNoteLimit(['a', 'b']), NOTE_NOT_TEXT_MESSAGE);
    assert.equal(validateNoteLimit({ texto: 'a' }), NOTE_NOT_TEXT_MESSAGE);
    assert.equal(validateNoteLimit(12), NOTE_NOT_TEXT_MESSAGE);
  });

  test('a mensagem é calma, em pt-BR, e diz o que fazer', () => {
    assert.match(NOTE_TOO_LONG_MESSAGE, /280 caracteres/);
    assert.match(NOTE_TOO_LONG_MESSAGE, /Encurte/);
  });
});

// Uma frase longa (mais de 280) que dispara o filtro de crise.
const LONG_CRISIS = `${'hoje o treino foi pesado e o dia inteiro foi corrido. '.repeat(6)}hoje eu so quero morrer`;

describe('limite da frase na rota de check-in', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', async (sql, params) => handle(sql, params));
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

  test('check-in com 280 caracteres passa e a frase é gravada inteira', async () => {
    const note = 'a'.repeat(280);
    const res = await post({ mission_id: 10, note });

    assert.equal(res.status, 201);
    assert.equal(db.checkins.length, 1);
    assert.equal(db.checkins[0].note, note);
  });

  test('280 emojis passam (são 280 caracteres, mesmo com mais bytes)', async () => {
    const note = '💪'.repeat(280);
    const res = await post({ mission_id: 10, note });

    assert.equal(res.status, 201);
    assert.equal(db.checkins[0].note, note);
  });

  test('check-in com 281 caracteres: 400 calmo, nada gravado, sem sinal de crise', async () => {
    const res = await post({ mission_id: 10, note: 'a'.repeat(281) });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, NOTE_TOO_LONG_MESSAGE);
    assert.equal('crisis' in res.body, false);
    assert.equal(db.checkins.length, 0);
    assert.ok(!db.queries.some(q => /^INSERT/i.test(q.text)), 'nada foi inserido');
    assert.ok(!db.queries.some(q => /^UPDATE/i.test(q.text)), 'o ponto não conta');
  });

  test('281 emojis: 400', async () => {
    const res = await post({ mission_id: 10, note: '💪'.repeat(281) });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, NOTE_TOO_LONG_MESSAGE);
    assert.equal(db.checkins.length, 0);
  });

  test('dia difícil com 280 passa; com 281 dá 400', async () => {
    const ok = await post({ mission_id: 10, difficult: true, minimum_done: true, note: 'b'.repeat(280) });
    assert.equal(ok.status, 201);
    assert.equal(db.checkins[0].is_difficult, true);

    resetDb();
    db.missions.set(10, missionRow());
    const longo = await post({ mission_id: 10, difficult: true, minimum_done: true, note: 'b'.repeat(281) });
    assert.equal(longo.status, 400);
    assert.equal(longo.body.error, NOTE_TOO_LONG_MESSAGE);
    assert.equal(db.checkins.length, 0);
  });

  test('dia difícil sem frase continua a passar', async () => {
    const res = await post({ mission_id: 10, difficult: true, minimum_done: true });

    assert.equal(res.status, 201);
    assert.equal(db.checkins[0].note, null);
  });

  test('nota longa com crise: abre a ajuda, conta o dia e não grava a nota', async () => {
    assert.ok([...LONG_CRISIS].length > 280);
    const res = await post({ mission_id: 10, note: LONG_CRISIS });

    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(db.checkins.length, 1);
    assert.equal(db.checkins[0].note, null);
    assertNowhere('morrer');
    assertNowhere('treino foi pesado');
    assert.deepEqual(logged, []);
  });

  test('nota longa com crise no dia difícil: abre a ajuda e não grava a nota', async () => {
    const res = await post({ mission_id: 10, difficult: true, minimum_done: true, note: LONG_CRISIS });

    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(db.checkins[0].is_difficult, true);
    assert.equal(db.checkins[0].note, null);
    assertNowhere('morrer');
  });

  test('nota que não é texto (lista) é recusada sem gravar', async () => {
    const res = await post({ mission_id: 10, note: ['a'.repeat(200), 'b'.repeat(200)] });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, NOTE_NOT_TEXT_MESSAGE);
    assert.equal(db.checkins.length, 0);
  });

  test('caso negado: sem login, nota longa dá 401 e nada é lido', async () => {
    const res = await post({ mission_id: 10, note: 'a'.repeat(281) }, { token: null });

    assert.equal(res.status, 401);
    assert.equal(db.queries.length, 0);
    assert.equal(db.checkins.length, 0);
  });

  test('caso negado: outra pessoa com nota longa recebe 404, não a mensagem do limite', async () => {
    const res = await post({ mission_id: 10, note: 'a'.repeat(281) }, { token: tokenFor(7) });

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Missão não encontrada.');
    assert.equal(db.checkins.length, 0);
  });

  test('caso negado: ex-participante (saiu do duo) com nota longa recebe 404', async () => {
    // A pessoa 2 era parceira; agora a vaga é da pessoa 3.
    db.missions.set(10, missionRow({ mode: 'duo', partner_id: 3 }));
    const res = await post({ mission_id: 10, note: 'a'.repeat(281) }, { token: tokenFor(2) });

    assert.equal(res.status, 404);
    assert.equal(db.checkins.length, 0);
  });

  test('caso negado: ex-participante com nota longa e crise vê o sinal de ajuda e nada é gravado', async () => {
    db.missions.set(10, missionRow({ mode: 'duo', partner_id: 3 }));
    const res = await post({ mission_id: 10, note: LONG_CRISIS }, { token: tokenFor(2) });

    assert.equal(res.status, 404);
    assert.equal(res.body.crisis, true);
    assert.equal(db.checkins.length, 0);
    assertNowhere('morrer');
  });
});
