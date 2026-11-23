const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const webpush = require('web-push');
const { withAuthDb } = require('./helpers/auth-db');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

// Chat do Duo/Rival, PR C: aviso de mensagem nova (decisão de 23/11).
// Texto fixo, sem nome nem trecho; interruptor próprio desligado por padrão
// (migração 010); no máximo 1 por dia por conversa; nunca para crise.
// Banco e push simulados.
const messagesRouter = require('../routes/messages');
const { parsePrefsBody, messagesAllowedSql, allowedSqlFor } = require('../lib/notification-preferences');

const app = express();
app.use(express.json());
app.use('/api/messages', messagesRouter);

const NOTICE = { title: 'Você tem uma mensagem nova.', body: '', url: '/nexus-v2/missao.html' };

// users: id -> { message_notice_opt_in, reminders_opt_in, subscribed, name }
const db = { migrated: true, users: new Map(), missions: [], messages: [], log: new Set(), queries: [] };

function resetDb() {
  db.migrated = true;
  db.users = new Map([
    [1, { id: 1, name: 'dono-teste', subscribed: true, message_notice_opt_in: true }],
    [2, { id: 2, name: 'parceira-teste', subscribed: true, message_notice_opt_in: true }],
    [3, { id: 3, name: 'sem-aviso', subscribed: true, message_notice_opt_in: false, reminders_opt_in: true }],
    [4, { id: 4, name: 'nunca-escolheu', subscribed: true, reminders_opt_in: true }]
  ]);
  db.missions = [
    { id: 7, user_id: 1, partner_id: 2, status: 'active', mode: 'parceiro' },
    { id: 8, user_id: 1, partner_id: 3, status: 'active', mode: 'rival' },
    { id: 9, user_id: 1, partner_id: 4, status: 'active', mode: 'parceiro' }
  ];
  db.messages = [];
  db.log = new Set();
  db.queries = [];
}

const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const noticeOn = (user) => db.migrated && user && user.message_notice_opt_in === true;

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
  if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) return { rows: [{ id: params[0] }] };

  if (/^SELECT \* FROM missions m WHERE id = \$1/i.test(text)) {
    const m = db.missions.find((item) => item.id === Number(params[0])
      && (item.user_id === Number(params[1]) || item.partner_id === Number(params[1])));
    return { rows: m ? [{ ...m }] : [] };
  }
  if (/INTERVAL '5 seconds'/i.test(text)) {
    const row = db.messages.find((item) => item.mission_id === Number(params[0])
      && item.sender_id === Number(params[1]) && item.content === params[2]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (/INTERVAL '24 hours'/i.test(text)) return { rows: [{ last_hour: '0', last_day: '0' }] };
  if (/^INSERT INTO messages/i.test(text)) {
    db.messages.push({ id: db.messages.length + 1, mission_id: Number(params[0]), sender_id: Number(params[1]), content: params[2] });
    return { rows: [{ id: db.messages.length }], rowCount: 1 };
  }
  if (/WHERE m\.id = \$1$/i.test(text)) return { rows: [{ ...db.messages[Number(params[0]) - 1] }] };

  // Reserva do aviso do dia: só para quem ligou o aviso de mensagem.
  if (/^INSERT INTO notification_log/i.test(text)) {
    assert.match(text, /message_notice_opt_in/, 'a reserva usa o interruptor próprio');
    assert.doesNotMatch(text, /reminders_opt_in/, 'o aviso de mensagem não depende dos lembretes');
    const user = db.users.get(Number(params[0]));
    if (!noticeOn(user)) return { rows: [] };
    const key = `${params[0]}|${params[1]}|${params[2]}|hoje`;
    if (db.log.has(key)) return { rows: [] };
    db.log.add(key);
    return { rows: [{ id: db.log.size }] };
  }
  if (/FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE ps.user_id = \$1/.test(text)) {
    assert.match(text, /message_notice_opt_in/);
    const user = db.users.get(Number(params[0]));
    return { rows: user && user.subscribed && noticeOn(user)
      ? [{ endpoint: `https://push.example.test/${user.id}`, p256dh: 'k', auth: 'a' }] : [] };
  }
  return { rows: [] };
}

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);
let server;
let baseUrl;
const pushes = [];
const consoleCalls = [];
let pushFails = false;

async function send(missionId, content, userId = 1) {
  const response = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(userId)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mission_id: missionId, content })
  });
  return { status: response.status, body: await response.json() };
}

describe('chat do Duo/Rival: aviso de mensagem nova', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({ query: async (s, p) => handle(s, p), release() {} }));
    mock.method(webpush, 'sendNotification', async (subscription, payload) => {
      if (pushFails) throw Object.assign(new Error('falha simulada'), { statusCode: 500 });
      pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      return {};
    });
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
    pushes.length = 0;
    consoleCalls.length = 0;
    pushFails = false;
  });

  test('a outra pessoa recebe o aviso com texto fixo, sem nome nem trecho', async () => {
    const res = await send(7, 'segredinho do treino de hoje');
    assert.equal(res.status, 201);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].endpoint, 'https://push.example.test/2');
    assert.deepEqual(pushes[0].payload, NOTICE);
    const raw = JSON.stringify(pushes[0]);
    for (const leak of ['segredinho', 'treino', 'dono-teste', 'parceira-teste', '"7"', 'mission']) {
      assert.equal(raw.includes(leak), false, `o aviso não leva «${leak}»`);
    }
  });

  test('funciona dos dois lados e quem envia não recebe o próprio aviso', async () => {
    await send(7, 'oi', 2);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].endpoint, 'https://push.example.test/1');
  });

  test('no máximo 1 aviso por dia por conversa', async () => {
    for (const content of ['um', 'dois', 'tres', 'quatro']) assert.equal((await send(7, content)).status, 201);
    assert.equal(pushes.length, 1);
    assert.equal(db.messages.length, 4);
  });

  test('negado: aviso desligado ou nunca escolhido não sai (nem com lembretes ligados)', async () => {
    assert.equal((await send(8, 'oi rival')).status, 201);
    assert.equal((await send(9, 'oi')).status, 201);
    assert.equal(pushes.length, 0);
    assert.equal(db.log.size, 0, 'nada é reservado para quem não ligou o aviso');
  });

  test('negado: antes da migração 010 nenhum aviso sai', async () => {
    db.migrated = false;
    assert.equal((await send(7, 'oi')).status, 201);
    assert.equal(pushes.length, 0);
  });

  test('negado: mensagem barrada por crise nunca gera aviso nem reserva', async () => {
    const res = await send(7, 'quero morrer');
    assert.equal(res.body.crisis, true);
    assert.equal(pushes.length, 0);
    assert.equal(db.log.size, 0);
    assert.equal(db.queries.length, 0);
    // E o aviso do dia continua livre para a próxima mensagem normal.
    await send(7, 'oi');
    assert.equal(pushes.length, 1);
  });

  test('negado: mensagem recusada (tamanho, sem par, sem acesso) não gera aviso', async () => {
    assert.equal((await send(7, 'a'.repeat(281))).status, 400);
    assert.equal((await send(7, 'oi', 9)).status, 403);
    db.missions[0].partner_id = null;
    assert.equal((await send(7, 'oi')).status, 400);
    assert.equal(pushes.length, 0);
  });

  test('duplicata em 5 segundos não gera segundo aviso', async () => {
    await send(7, 'repetida');
    db.log.clear(); // mesmo com a reserva livre, a duplicata sai antes
    const again = await send(7, 'repetida');
    assert.equal(again.body.deduped, true);
    assert.equal(pushes.length, 1);
  });

  test('falha do push não derruba o envio e não vai texto para o log', async () => {
    pushFails = true;
    const res = await send(7, 'conteudo privado');
    assert.equal(res.status, 201);
    assert.equal(consoleCalls.some((args) => JSON.stringify(args).includes('conteudo privado')), false);
  });

  test('a escolha do aviso é separada: PUT aceita messages; SQL só olha a coluna nova', () => {
    assert.deepEqual(parsePrefsBody({ messages: true }), { messages: true });
    assert.equal(parsePrefsBody({ messages: 'sim' }), null);
    assert.match(messagesAllowedSql('u'), /message_notice_opt_in/);
    assert.doesNotMatch(messagesAllowedSql('u'), /reminders_opt_in|news_opt_in/);
    assert.equal(allowedSqlFor('messages', 'u'), messagesAllowedSql('u'));
    // Sem a coluna, o JSON não tem a chave: a comparação dá NULL, ou seja, não envia.
    assert.doesNotMatch(messagesAllowedSql('u'), /NOT \(to_jsonb/);
  });
});

test('010: só acrescenta, sem default, registra a versão e explica a volta', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '010_user_message_notice.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(code, /DEFAULT/i);
  for (const col of ['message_notice_opt_in BOOLEAN', 'message_notice_opt_in_at TIMESTAMPTZ',
    'message_notice_opt_in_version VARCHAR(40)']) {
    assert.ok(code.includes(`ADD COLUMN IF NOT EXISTS ${col}`), col);
  }
  assert.match(code, /CHECK \(message_notice_opt_in IS NULL OR message_notice_opt_in_at IS NOT NULL\)/);
  assert.match(code, /'010_user_message_notice'/);
  assert.match(sql, /Para voltar atrás/);
  assert.match(sql, /NÃO APLICAR/);
});
