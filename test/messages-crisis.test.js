const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const webpush = require('web-push');
const { withAuthDb } = require('./helpers/auth-db');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

// Chat do Duo/Rival: filtro de crise no envio (PR A do plano do chat).
// Banco simulado; nenhuma conexão real. Frases de crise são só de exemplo.
const messagesRouter = require('../routes/messages');

const app = express();
app.use(express.json());
app.use('/api/messages', messagesRouter);

const CRISIS_TEXT = 'Sua mensagem não foi enviada. Parece que você está passando por um momento difícil. Veja os contatos de ajuda.';

// Missão 7: dono 1, parceiro 2. A pessoa 3 não participa. A 4 saiu do par.
const db = { missions: [], messages: [], queries: [] };

function resetDb() {
  db.missions = [
    { id: 7, user_id: 1, partner_id: 2, status: 'active', mode: 'parceiro' },
    { id: 8, user_id: 5, partner_id: null, status: 'active', mode: 'solo' }
  ];
  db.messages = [];
  db.queries = [];
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^SELECT \* FROM missions m WHERE id = \$1 AND \( m\.user_id = \$2 OR m\.partner_id = \$2 \)$/i.test(text)) {
    const m = db.missions.find((item) => item.id === Number(params[0])
      && (item.user_id === Number(params[1]) || item.partner_id === Number(params[1])));
    return { rows: m ? [{ ...m }] : [] };
  }
  if (/FROM messages m JOIN users u ON u\.id = m\.sender_id WHERE m\.mission_id = \$1 AND m\.sender_id = \$2 AND m\.content = \$3/i.test(text)) {
    return { rows: [] };
  }
  if (/FROM messages WHERE sender_id = \$1 AND created_at > NOW\(\) - INTERVAL '24 hours'/i.test(text)) {
    return { rows: [{ last_hour: '0', last_day: '0' }] };
  }
  if (/^INSERT INTO messages/i.test(text)) {
    const row = { id: db.messages.length + 1, mission_id: Number(params[0]), sender_id: Number(params[1]), content: params[2] };
    db.messages.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/FROM messages m JOIN users u ON u\.id = m\.sender_id WHERE m\.id = \$1/i.test(text)) {
    const row = db.messages.find((item) => item.id === Number(params[0]));
    return { rows: row ? [{ ...row, sender_name: `pessoa${row.sender_id}` }] : [] };
  }
  return { rows: [] };
}

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);
const inserted = () => db.queries.some((q) => /^INSERT INTO messages/i.test(q.text));
const textReachedDb = (fragment) => db.queries.some((q) =>
  q.params.some((p) => typeof p === 'string' && p.includes(fragment)));

let server;
let baseUrl;
const consoleCalls = [];
const pushCalls = [];

async function send(body, token) {
  const response = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : {} };
}

const logged = (fragment) => consoleCalls.some((args) => args.some((a) => String(a && a.stack ? a.stack : a).includes(fragment)
  || (typeof a === 'object' && JSON.stringify(a || {}).includes(fragment))));

describe('chat do Duo/Rival: filtro de crise no envio', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params),
      { missing: (id) => id === 99 }));
    mock.method(Pool.prototype, 'connect', async () => ({
      query: async (sql, params) => handle(sql, params),
      release() {}
    }));
    mock.method(webpush, 'sendNotification', async (...args) => { pushCalls.push(args); return {}; });
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
    pushCalls.length = 0;
  });

  test('crise ALTO: não grava, não chama push, não vai ao log e responde 200 com crisis', async () => {
    const res = await send({ mission_id: 7, content: 'quero morrer' }, tokenFor(1));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sent: false, crisis: true, crisis_level: 'alto', message: CRISIS_TEXT });
    assert.equal(inserted(), false);
    assert.equal(db.messages.length, 0);
    assert.equal(textReachedDb('quero morrer'), false, 'o texto não chega ao banco');
    assert.equal(db.queries.length, 0, 'nenhuma consulta ao banco com alerta (nem a de duplicata)');
    assert.equal(pushCalls.length, 0, 'nenhum aviso sai');
    assert.equal(consoleCalls.length, 0, 'nada vai para o log');
    assert.equal(logged('quero morrer'), false);
  });

  test('crise MÉDIO: também não grava e devolve crisis_level medio', async () => {
    const res = await send({ mission_id: 7, content: 'nao vejo saida' }, tokenFor(2));
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'medio');
    assert.equal(res.body.sent, false);
    assert.equal(inserted(), false);
    assert.equal(pushCalls.length, 0);
    assert.equal(consoleCalls.length, 0);
  });

  test('a resposta de crise não traz nada da missão nem do parceiro', async () => {
    const res = await send({ mission_id: 7, content: 'me matar hoje' }, tokenFor(1));
    assert.deepEqual(Object.keys(res.body).sort(), ['crisis', 'crisis_level', 'message', 'sent']);
  });

  test('mensagem normal grava (201) e não traz crisis', async () => {
    const res = await send({ mission_id: 7, content: 'bora, hoje eu treinei cedo' }, tokenFor(2));
    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, undefined);
    assert.equal(db.messages.length, 1);
    assert.equal(db.messages[0].content, 'bora, hoje eu treinei cedo');
    assert.equal(db.messages[0].sender_id, 2);
    assert.equal(consoleCalls.length, 0);
  });

  test('exceção do filtro continua valendo no chat («vou me matar de treinar» grava)', async () => {
    const res = await send({ mission_id: 7, content: 'vou me matar de treinar amanha' }, tokenFor(1));
    assert.equal(res.status, 201);
    assert.equal(db.messages.length, 1);
  });

  test('negado: quem não participa recebe 403 e nada é gravado', async () => {
    const res = await send({ mission_id: 7, content: 'oi, posso entrar?' }, tokenFor(3));
    assert.equal(res.status, 403);
    assert.equal(inserted(), false);
  });

  test('negado: ex-participante (fora do par) recebe 403 e nada é gravado', async () => {
    db.missions[0].partner_id = null; // a pessoa 2 saiu do Duo
    const res = await send({ mission_id: 7, content: 'ainda estou aqui' }, tokenFor(2));
    assert.equal(res.status, 403);
    assert.equal(inserted(), false);
  });

  test('negado: sem login (401), nem com frase de crise o servidor lê o banco', async () => {
    for (const content of ['oi', 'quero morrer']) {
      const res = await send({ mission_id: 7, content });
      assert.equal(res.status, 401);
      assert.equal(res.body.crisis, undefined);
    }
    assert.equal(db.queries.length, 0);
    assert.equal(consoleCalls.length, 0);
  });

  test('negado: conta que não existe mais (401)', async () => {
    const res = await send({ mission_id: 7, content: 'oi' }, tokenFor(99));
    assert.equal(res.status, 401);
    assert.equal(inserted(), false);
  });

  test('crise vale também para quem não participa: mostra a ajuda e não lê a missão', async () => {
    const res = await send({ mission_id: 7, content: 'quero morrer' }, tokenFor(3));
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(db.queries.length, 0);
  });

  test('o texto de crise não aparece em log nem quando o banco falha depois', async () => {
    // Uma mensagem normal com o banco falhando: 500 calmo, sem log.
    mock.method(Pool.prototype, 'query', withAuthDb(async () => { throw new Error('falha simulada'); }));
    try {
      const res = await send({ mission_id: 7, content: 'oi de novo' }, tokenFor(1));
      assert.equal(res.status, 500);
      assert.equal(consoleCalls.length, 0);
      const crisis = await send({ mission_id: 7, content: 'quero morrer' }, tokenFor(1));
      assert.equal(crisis.status, 200);
      assert.equal(crisis.body.crisis, true);
      assert.equal(logged('quero morrer'), false);
    } finally {
      mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params),
        { missing: (id) => id === 99 }));
    }
  });
});
