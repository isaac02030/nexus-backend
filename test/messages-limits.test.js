const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

// Chat do Duo/Rival, PR B: 280 caracteres, frequência (20 por hora, 200 por
// dia) e só com Duo/Rival ativo. Banco simulado; nenhuma conexão real.
const messagesRouter = require('../routes/messages');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/messages', messagesRouter);

const db = { missions: [], messages: [], queries: [], lockHeld: null, waiters: [], failInsert: false };

function resetDb() {
  db.missions = [
    { id: 7, user_id: 1, partner_id: 2, status: 'active', mode: 'parceiro' },
    { id: 8, user_id: 3, partner_id: 4, status: 'active', mode: 'rival' },
    { id: 9, user_id: 5, partner_id: null, status: 'active', mode: 'solo' },
    { id: 10, user_id: 6, partner_id: null, status: 'active', mode: 'parceiro' },
    { id: 11, user_id: 1, partner_id: 2, status: 'completed', mode: 'parceiro' }
  ];
  db.messages = [];
  db.queries = [];
  db.lockHeld = null;
  db.waiters = [];
  db.failInsert = false;
}

const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const MINUTE = 60 * 1000;

// Mensagens antigas da pessoa, com "idade" em minutos.
function seed(senderId, count, ageMinutes) {
  for (let i = 0; i < count; i++) {
    db.messages.push({ id: db.messages.length + 1, mission_id: 7, sender_id: senderId, content: `antiga ${i}`,
      created_at: Date.now() - ageMinutes * MINUTE });
  }
}

// Uma transação por conexão. O "FOR UPDATE" na linha da pessoa faz o segundo
// pedido esperar o primeiro terminar, como no Postgres.
function connection() {
  let holds = false;
  const release = () => {
    if (!holds) return;
    holds = false;
    db.lockHeld = null;
    const next = db.waiters.shift();
    if (next) next();
  };
  const query = async (sql, params = []) => {
    const text = normalize(sql);
    if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) {
      db.queries.push({ text, params });
      if (db.lockHeld !== null) await new Promise((resolve) => db.waiters.push(resolve));
      db.lockHeld = Number(params[0]);
      holds = true;
      return { rows: [{ id: Number(params[0]) }] };
    }
    if (/^(COMMIT|ROLLBACK)$/.test(text)) {
      db.queries.push({ text, params });
      release();
      return { rows: [] };
    }
    // Dá tempo para o outro pedido tentar entrar no meio.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return handle(sql, params);
  };
  return { query, release };
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (/^BEGIN$/.test(text)) return { rows: [] };

  if (/^SELECT \* FROM missions m WHERE id = \$1 AND \( m\.user_id = \$2 OR m\.partner_id = \$2 \)$/i.test(text)) {
    const m = db.missions.find((item) => item.id === Number(params[0])
      && (item.user_id === Number(params[1]) || item.partner_id === Number(params[1])));
    return { rows: m ? [{ ...m }] : [] };
  }
  if (/AND m\.content = \$3 AND m\.created_at >= NOW\(\) - INTERVAL '5 seconds'/i.test(text)) {
    const row = db.messages.find((item) => item.mission_id === Number(params[0]) && item.sender_id === Number(params[1])
      && item.content === params[2] && Date.now() - item.created_at <= 5000);
    return { rows: row ? [{ ...row, sender_name: 'p' }] : [] };
  }
  if (/FROM messages WHERE sender_id = \$1 AND created_at > NOW\(\) - INTERVAL '24 hours'/i.test(text)) {
    const mine = db.messages.filter((item) => item.sender_id === Number(params[0]));
    const day = mine.filter((item) => Date.now() - item.created_at < 24 * 60 * MINUTE).length;
    const hour = mine.filter((item) => Date.now() - item.created_at < 60 * MINUTE).length;
    return { rows: [{ last_hour: String(hour), last_day: String(day) }] };
  }
  if (/^INSERT INTO messages/i.test(text)) {
    if (db.failInsert) throw new Error('falha simulada');
    const row = { id: db.messages.length + 1, mission_id: Number(params[0]), sender_id: Number(params[1]),
      content: params[2], created_at: Date.now() };
    db.messages.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/WHERE m\.id = \$1$/i.test(text)) {
    const row = db.messages.find((item) => item.id === Number(params[0]));
    return { rows: row ? [{ ...row, sender_name: 'p' }] : [] };
  }
  return { rows: [] };
}

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);
const inserted = () => db.queries.filter((q) => /^INSERT INTO messages/i.test(q.text)).length;
const touchedDb = () => db.queries.length > 0;

let server;
let baseUrl;
const consoleCalls = [];

async function send(body, token = tokenFor(1), raw = false) {
  const response = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

describe('chat do Duo/Rival: tamanho, frequência e par ativo', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => connection());
    for (const name of ['log', 'error', 'warn', 'info', 'debug']) {
      mock.method(console, name, (...args) => { consoleCalls.push(args); });
    }
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetDb();
    consoleCalls.length = 0;
  });

  // ---------- Tamanho ----------
  test('280 caracteres reais passam (emojis contam 1)', async () => {
    assert.equal((await send({ mission_id: 7, content: 'a'.repeat(280) })).status, 201);
    assert.equal((await send({ mission_id: 7, content: '💪'.repeat(280) })).status, 201);
    assert.equal(inserted(), 2);
  });

  test('negado: 281 caracteres dá 400 com texto calmo e nada é gravado', async () => {
    const res = await send({ mission_id: 7, content: 'a'.repeat(281) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'A mensagem passou de 280 caracteres. Encurte um pouco e envie de novo.');
    assert.equal(inserted(), 0);
    assert.equal(touchedDb(), false, 'recusado antes do banco');
  });

  test('negado: texto de 5000 caracteres com frase de crise no começo mostra a ajuda', async () => {
    const content = `quero morrer ${'a'.repeat(5000)}`;
    assert.ok([...content].length > 5000);
    const res = await send({ mission_id: 7, content });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(res.body.sent, false);
    assert.equal(touchedDb(), false);
    assert.equal(consoleCalls.length, 0);
  });

  test('negado: texto enorme sem crise nos primeiros 1000 caracteres é recusado sem tocar no banco', async () => {
    const res = await send({ mission_id: 7, content: 'b'.repeat(5000) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'A mensagem passou de 280 caracteres. Encurte um pouco e envie de novo.');
    assert.equal(res.body.crisis, undefined);
    assert.equal(touchedDb(), false);
    // O filtro lê no máximo 1000 caracteres: depois disso, vale só o tamanho.
    const late = await send({ mission_id: 7, content: `${'b '.repeat(600)}quero morrer` });
    assert.equal(late.status, 400);
    assert.equal(late.body.crisis, undefined);
  });

  test('crise numa mensagem um pouco longa (até o teto) ainda mostra a ajuda', async () => {
    const res = await send({ mission_id: 7, content: `quero morrer ${'a'.repeat(400)}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(touchedDb(), false);
  });

  test('negado: conteúdo que não é texto, vazio ou só espaços dá 400', async () => {
    for (const content of [42, { a: 1 }, ['x'], true]) {
      const res = await send({ mission_id: 7, content });
      assert.equal(res.status, 400, JSON.stringify(content));
    }
    for (const content of ['', '   ', undefined]) {
      assert.equal((await send({ mission_id: 7, content })).status, 400);
    }
    assert.equal((await send('null', tokenFor(1), true)).status, 400, 'corpo «null» não derruba a rota');
    assert.equal((await send('{}', tokenFor(1), true)).status, 400, 'corpo sem campos dá 400');
    assert.equal(inserted(), 0);
  });

  // ---------- Par ativo ----------
  test('Duo (parceiro) e Rival ativos podem enviar, dos dois lados', async () => {
    assert.equal((await send({ mission_id: 7, content: 'oi' }, tokenFor(1))).status, 201);
    assert.equal((await send({ mission_id: 7, content: 'oi de volta' }, tokenFor(2))).status, 201);
    assert.equal((await send({ mission_id: 8, content: 'bora' }, tokenFor(3))).status, 201);
  });

  test('negado: Solo, missão sem a outra pessoa e missão encerrada não enviam', async () => {
    const solo = await send({ mission_id: 9, content: 'oi' }, tokenFor(5));
    assert.equal(solo.status, 400);
    assert.equal(solo.body.error, 'A conversa só funciona enquanto o Duo ou o Rival estiver ativo.');
    assert.equal((await send({ mission_id: 10, content: 'oi' }, tokenFor(6))).status, 400);
    assert.equal((await send({ mission_id: 11, content: 'oi' }, tokenFor(1))).status, 400);
    assert.equal(inserted(), 0);
  });

  test('negado: quem não participa continua com 403', async () => {
    assert.equal((await send({ mission_id: 7, content: 'oi' }, tokenFor(5))).status, 403);
    assert.equal(inserted(), 0);
  });

  // ---------- Frequência ----------
  test('a 20.ª mensagem da hora passa; a 21.ª dá 429', async () => {
    seed(1, 19, 10);
    assert.equal((await send({ mission_id: 7, content: 'vigésima' })).status, 201);
    const res = await send({ mission_id: 7, content: 'vigésima primeira' });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'Você enviou muitas mensagens nesta hora. Espere um pouco e envie de novo.');
    assert.equal(res.body.limit, 20);
    assert.equal(res.body.period, 'hour');
    assert.equal(inserted(), 1);
  });

  test('mensagens de mais de 1 hora não contam no limite da hora', async () => {
    seed(1, 20, 90);
    assert.equal((await send({ mission_id: 7, content: 'nova hora' })).status, 201);
  });

  test('negado: 200 no dia dá 429 com o texto do dia, mesmo com a hora livre', async () => {
    seed(1, 200, 120);
    const res = await send({ mission_id: 7, content: 'mais uma' });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'Você chegou ao limite de mensagens de hoje. Amanhã dá para enviar de novo.');
    assert.equal(res.body.limit, 200);
    assert.equal(res.body.period, 'day');
    assert.equal(inserted(), 0);
  });

  test('o limite é por pessoa: o parceiro continua podendo enviar', async () => {
    seed(1, 20, 5);
    assert.equal((await send({ mission_id: 7, content: 'oi' }, tokenFor(1))).status, 429);
    assert.equal((await send({ mission_id: 7, content: 'oi' }, tokenFor(2))).status, 201);
  });

  test('negado: pedidos ao mesmo tempo não passam do limite (transação com a linha travada)', async () => {
    seed(1, 18, 5);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      send({ mission_id: 7, content: `ao mesmo tempo ${i}` })));
    const ok = results.filter((r) => r.status === 201).length;
    const limited = results.filter((r) => r.status === 429).length;
    assert.equal(ok, 2, 'só cabem 2 até a 20.ª');
    assert.equal(limited, 4);
    assert.equal(db.messages.filter((m) => m.sender_id === 1).length, 20);
  });

  test('duplicata em 5 segundos não grava de novo nem conta no limite', async () => {
    assert.equal((await send({ mission_id: 7, content: 'repetida' })).status, 201);
    const again = await send({ mission_id: 7, content: 'repetida' });
    assert.equal(again.status, 200);
    assert.equal(again.body.deduped, true);
    assert.equal(inserted(), 1);
  });

  test('erro do banco: 500 calmo, ROLLBACK e nada no log', async () => {
    db.failInsert = true;
    const res = await send({ mission_id: 7, content: 'segredo do treino' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Erro ao enviar mensagem.');
    assert.ok(db.queries.some((q) => q.text === 'ROLLBACK'));
    assert.equal(consoleCalls.length, 0);
  });
});
