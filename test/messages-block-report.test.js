const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

// Chat do Duo/Rival, PR D: bloquear (encerra o par, impede um novo par) e
// denunciar uma mensagem (migração 011, NÃO aplicada). Banco simulado.
const messagesRouter = require('../routes/messages');
const { tryMatchMission } = require('../routes/missions');
const { ACCOUNT_DELETION_STEPS, deleteAccountData } = require('../lib/account-deletion');

const app = express();
app.use(express.json());
app.use('/api/messages', messagesRouter);

const ADMIN = 1;
const db = {};
const OLD_PAIR = new Date('2026-11-20T10:00:00Z');
const OLD_MESSAGE = new Date('2026-11-21T10:00:00Z');

function resetDb() {
  db.migrated = true;
  db.queries = [];
  db.blocks = [];
  db.reports = [];
  db.missions = [
    // Par por mission_matches: 10 e 11, cada um com a sua missão.
    { id: 100, user_id: 10, partner_id: 11, mode: 'parceiro', status: 'active', match_preference: 'parceiro', level: 'iniciante', category: 'estudo' },
    { id: 101, user_id: 11, partner_id: 10, mode: 'parceiro', status: 'active', match_preference: 'parceiro', level: 'iniciante', category: 'estudo' },
    // Duo na mesma missão: dono 20, parceiro 21.
    { id: 200, user_id: 20, partner_id: 21, mode: 'parceiro', status: 'active' },
    // Solo.
    { id: 300, user_id: 30, partner_id: null, mode: 'solo', status: 'active' }
  ];
  db.matches = [{ id: 1, mission_a_id: 100, mission_b_id: 101, status: 'active', started_at: OLD_PAIR }];
  db.missions[2].pair_started_at = OLD_PAIR;
  db.failEnd = false;
  db.clockShift = 0;
  db.messages = [
    { id: 1, mission_id: 100, sender_id: 10, content: 'oi do dez' },
    { id: 2, mission_id: 101, sender_id: 11, content: 'oi do onze' },
    { id: 3, mission_id: 200, sender_id: 21, content: 'oi do vinte e um' },
    { id: 4, mission_id: 200, sender_id: 20, content: 'oi do vinte' },
    { id: 5, mission_id: 300, sender_id: 30, content: 'sozinho' }
  ].map((m) => ({ ...m, created_at: OLD_MESSAGE }));
}

// Relógio do banco (NOW()). clockShift simula um banco em outro fuso que o
// Node: um TIMESTAMP sem fuso gravado a partir de um Date do Node fica deslocado.
const dbNow = () => new Date(Date.now() + db.clockShift);

// Mensagem nova (depois de um par novo), com o relógio do banco, como NOW().
function newMessage(missionId, senderId, content, afterMs = 60 * 1000) {
  const row = { id: db.messages.length + 1, mission_id: missionId, sender_id: senderId, content,
    created_at: new Date(dbNow().getTime() + afterMs) };
  db.messages.push(row);
  return row;
}

const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const missing = () => Object.assign(new Error('relation does not exist'), { code: '42P01' });
const mission = (id) => db.missions.find((m) => m.id === Number(id));
const blocked = (a, b) => db.blocks.some((x) => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
const activeMatchOf = (id) => db.matches.find((mm) => mm.status === 'active' && (mm.mission_a_id === id || mm.mission_b_id === id));

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });
  if (!db.migrated && /user_blocks|message_reports/.test(text) && !/to_regclass/.test(text)) throw missing();
  // Transação de verdade no simulador: ROLLBACK desfaz tudo desde o BEGIN.
  if (text === 'BEGIN') {
    db.snapshot = JSON.stringify({ missions: db.missions, matches: db.matches, blocks: db.blocks, reports: db.reports });
    return { rows: [] };
  }
  if (text === 'ROLLBACK') {
    if (db.snapshot) {
      const back = JSON.parse(db.snapshot);
      db.missions = back.missions;
      db.matches = back.matches.map((mm) => ({ ...mm, started_at: mm.started_at && new Date(mm.started_at) }));
      db.blocks = back.blocks;
      db.reports = back.reports;
    }
    db.snapshot = null;
    return { rows: [] };
  }
  if (text === 'COMMIT') { db.snapshot = null; return { rows: [] }; }
  if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) return { rows: [{ id: params[0] }] };

  if (/^SELECT \* FROM missions m WHERE id = \$1 AND \( m\.user_id = \$2 OR m\.partner_id = \$2 \)$/.test(text)) {
    const m = mission(params[0]);
    const ok = m && (m.user_id === Number(params[1]) || m.partner_id === Number(params[1]));
    return { rows: ok ? [{ ...m }] : [] };
  }
  // Par ativo (activePartnerOf e endLinkedMissionMatch).
  if (/FROM mission_matches mm JOIN missions ma ON ma\.id = mm\.mission_a_id/.test(text)) {
    const mm = activeMatchOf(Number(params[0]));
    if (!mm) return { rows: [] };
    const a = mission(mm.mission_a_id);
    const b = mission(mm.mission_b_id);
    if (/FOR UPDATE OF mm/.test(text) && a.user_id !== Number(params[1]) && b.user_id !== Number(params[1])) return { rows: [] };
    return { rows: [{ ...mm, user_a: a.user_id, user_b: b.user_id, mission_a: a.id, mission_b: b.id }] };
  }
  if (/^INSERT INTO user_blocks/.test(text)) {
    if (!blocked(Number(params[0]), Number(params[1])) || !db.blocks.some((x) => x.blocker_id === Number(params[0]) && x.blocked_id === Number(params[1]))) {
      db.blocks.push({ blocker_id: Number(params[0]), blocked_id: Number(params[1]) });
    }
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE missions SET mode = 'solo', partner_id = NULL, match_preference = NULL, pair_started_at = NULL WHERE id = \$1$/.test(text)) {
    Object.assign(mission(params[0]), { mode: 'solo', partner_id: null, match_preference: null });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE missions SET mode = 'solo', partner_id = NULL, match_preference = NULL, pair_started_at = NULL, status = CASE/.test(text)) {
    for (const id of [params[0], params[1]]) Object.assign(mission(id), { mode: 'solo', partner_id: null, match_preference: null });
    return { rows: [], rowCount: 2 };
  }
  if (/^UPDATE mission_matches SET status = 'ended'/.test(text)) {
    if (db.failEnd) throw new Error('falha simulada no fim do par');
    db.matches.find((mm) => mm.id === Number(params[0])).status = 'ended';
    return { rows: [], rowCount: 1 };
  }

  // GET da conversa.
  if (/^SELECT mission_a_id, mission_b_id FROM mission_matches/.test(text)) {
    const mm = activeMatchOf(Number(params[0]));
    return { rows: mm ? [{ ...mm }] : [] };
  }
  if (/^SELECT 1 FROM user_blocks WHERE/.test(text)) {
    return { rows: blocked(Number(params[0]), Number(params[1])) ? [{ '?column?': 1 }] : [] };
  }
  if (/FROM messages m JOIN users u ON m\.sender_id = u\.id WHERE m\.mission_id = ANY/.test(text)) {
    assert.match(text, /m\.sender_id = ANY\(\$2::int\[\]\)/);
    const ids = params[0].map(Number);
    const people = params[1].map(Number);
    // O simulador só aplica o que o SQL pede (uma mudança no SQL aparece aqui).
    const since = /m\.created_at >= \$3::timestamp/.test(text) && params[2] ? new Date(params[2]).getTime() : null;
    const rows = db.messages.filter((m) => ids.includes(m.mission_id) && people.includes(m.sender_id)
      && (since === null || new Date(m.created_at).getTime() >= since));
    return { rows: rows.map((m) => ({ ...m, sender_name: `pessoa${m.sender_id}` })) };
  }

  // Denúncia.
  if (/^SELECT msg\.id, msg\.sender_id FROM messages msg JOIN missions mi/.test(text)) {
    const msg = db.messages.find((m) => m.id === Number(params[0]));
    if (!msg) return { rows: [] };
    const mi = mission(msg.mission_id);
    const uid = Number(params[1]);
    const mm = activeMatchOf(mi.id);
    const viaMatch = mm && [mm.mission_a_id, mm.mission_b_id].some((id) => mission(id).user_id === uid);
    const ok = mi.user_id === uid || mi.partner_id === uid || viaMatch;
    return { rows: ok ? [{ id: msg.id, sender_id: msg.sender_id }] : [] };
  }
  if (/FROM message_reports WHERE reporter_id = \$1 AND created_at/.test(text)) {
    return { rows: [{ total: String(db.reports.filter((r) => r.reporter_id === Number(params[0])).length) }] };
  }
  if (/^INSERT INTO message_reports/.test(text)) {
    if (db.reports.some((r) => r.message_id === Number(params[0]) && r.reporter_id === Number(params[1]))) {
      return { rows: [], rowCount: 0 };
    }
    db.reports.push({ id: db.reports.length + 1, message_id: Number(params[0]), reporter_id: Number(params[1]),
      reason: params[2], details: params[3], created_at: '2026-11-23T18:00:00.000Z' });
    return { rows: [{ id: db.reports.length }], rowCount: 1 };
  }
  if (/FROM message_reports r JOIN messages msg/.test(text)) {
    return { rows: db.reports.map((r) => ({ ...r, excerpt: db.messages.find((m) => m.id === r.message_id).content,
      sender_name: 'nao-deveria-sair', reporter_name: 'nao-deveria-sair' })) };
  }

  // Juntar um par (tryMatchMission).
  if (/to_regclass\('public\.user_blocks'\)/.test(text)) return { rows: [{ ready: db.migrated }] };
  if (/^SELECT \* FROM missions WHERE id = \$1 AND user_id = \$2 AND status = 'active' AND mode = 'solo'/.test(text)) {
    const m = mission(params[0]);
    const ok = m && m.user_id === Number(params[1]) && m.mode === 'solo' && m.partner_id == null;
    return { rows: ok ? [{ ...m }] : [] };
  }
  if (/^SELECT m\.\* FROM missions m WHERE m\.status = 'active' AND m\.mode = 'solo'/.test(text)) {
    const me = Number(params[2]);
    let rows = db.missions.filter((m) => m.status === 'active' && m.mode === 'solo' && m.match_preference === params[0]
      && m.user_id !== me && m.partner_id == null && !activeMatchOf(m.id));
    if (/user_blocks/.test(text)) rows = rows.filter((m) => !blocked(me, m.user_id));
    return { rows: rows.slice(0, 1).map((m) => ({ ...m })) };
  }
  if (/^INSERT INTO mission_matches/.test(text)) {
    // NOW() no SQL = relógio do banco; um parâmetro = relógio do Node.
    const startedAt = /NOW\(\)/.test(text) ? dbNow() : new Date(params[3]);
    db.matches.push({ id: db.matches.length + 1, mission_a_id: Number(params[0]), mission_b_id: Number(params[1]),
      status: 'active', started_at: startedAt });
    return { rows: [{ started_at: startedAt }], rowCount: 1 };
  }
  if (/^UPDATE missions SET mode = \$1, partner_id = \$2, pair_started_at = NOW\(\) WHERE id = \$3$/.test(text)) {
    Object.assign(mission(params[2]), { mode: params[0], partner_id: Number(params[1]), pair_started_at: dbNow() });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [] };
}

const client = () => ({ query: async (sql, params) => handle(sql, params), release() {} });
const pool = { connect: async () => client() };
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);

let server;
let baseUrl;
const consoleCalls = [];

async function call(method, url, userId, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const report = (messageId, userId, body = { reason: 'ofensa' }) => call('POST', `/api/messages/${messageId}/report`, userId, body);
const block = (missionId, userId) => call('POST', `/api/messages/${missionId}/block`, userId);

describe('chat do Duo/Rival: bloquear e denunciar', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => client());
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

  // ---------- Bloquear ----------
  test('bloquear o par por mission_matches: encerra o par, ninguém é apagado', async () => {
    const res = await block(100, 10);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { blocked: true,
      message: 'Pronto. O par foi encerrado e vocês não vão ser juntados de novo. A conversa sumiu para os dois.' });
    assert.deepEqual(db.blocks, [{ blocker_id: 10, blocked_id: 11 }]);
    assert.equal(db.matches[0].status, 'ended');
    for (const id of [100, 101]) {
      assert.equal(mission(id).mode, 'solo');
      assert.equal(mission(id).partner_id, null);
      assert.equal(mission(id).status, 'active', 'as missões continuam');
    }
    assert.equal(db.messages.length, 5, 'nenhuma mensagem apagada');
    assert.equal(db.queries.some((q) => /^DELETE/.test(q.text)), false);
    assert.equal(consoleCalls.length, 0);
  });

  test('antes do bloqueio, os dois veem a conversa inteira do par', async () => {
    const ten = await call('GET', '/api/messages/100', 10);
    assert.deepEqual(ten.body.messages.map((m) => m.id), [1, 2]);
    const owner = await call('GET', '/api/messages/200', 20);
    assert.deepEqual(owner.body.messages.map((m) => m.id), [3, 4]);
  });

  test('negado: depois do bloqueio, os dois veem a conversa vazia (nada apagado)', async () => {
    await block(100, 10);
    for (const [mission, user] of [[100, 10], [101, 11]]) {
      const res = await call('GET', `/api/messages/${mission}`, user);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.messages, [], `missão ${mission}`);
    }
    assert.equal(db.messages.length, 5);
  });

  test('negado: o dono que forma um par novo não vê as mensagens do par antigo, nem o par novo', async () => {
    await block(100, 10);
    // Par novo de 10 com 12 (mission_matches).
    db.missions.push({ id: 102, user_id: 12, partner_id: null, mode: 'solo', status: 'active',
      match_preference: 'parceiro', level: 'iniciante', category: 'estudo' });
    mission(100).match_preference = 'parceiro';
    const paired = await tryMatchMission(mission(100), 10, pool);
    assert.equal(paired.partnerMission.user_id, 12);
    const mine = newMessage(100, 10, 'oi, doze');
    const theirs = newMessage(102, 12, 'oi, dez');
    const ten = await call('GET', '/api/messages/100', 10);
    const twelve = await call('GET', '/api/messages/102', 12);
    assert.deepEqual(ten.body.messages.map((m) => m.id), [mine.id, theirs.id]);
    assert.deepEqual(twelve.body.messages.map((m) => m.id), [mine.id, theirs.id]);
    for (const res of [ten, twelve]) {
      assert.equal(res.body.messages.some((m) => [1, 2].includes(m.id)), false, 'nada do par antigo');
    }
  });

  test('negado: no Duo da mesma missão, o parceiro novo não vê o que o antigo escreveu', async () => {
    // O parceiro 21 saiu; entrou o 22, com o par começando agora.
    Object.assign(mission(200), { partner_id: 22, pair_started_at: dbNow() });
    const fresh = newMessage(200, 22, 'cheguei');
    for (const user of [20, 22]) {
      const res = await call('GET', '/api/messages/200', user);
      assert.deepEqual(res.body.messages.map((m) => m.id), [fresh.id], `pessoa ${user}`);
    }
    // E quem saiu não lê mais nada da missão.
    assert.equal((await call('GET', '/api/messages/200', 21)).status, 403);
  });

  test('fuso: com o banco em outro fuso que o Node, as primeiras mensagens do par aparecem', async () => {
    db.clockShift = -3 * 60 * 60 * 1000; // o banco «está» 3 horas atrás do Node
    db.matches[0].status = 'ended';
    for (const id of [100, 101]) Object.assign(mission(id), { mode: 'solo', partner_id: null, match_preference: 'parceiro' });
    const paired = await tryMatchMission(mission(100), 10, pool);
    assert.ok(paired);
    const insert = db.queries.find((q) => /^INSERT INTO mission_matches/.test(q.text));
    assert.match(insert.text, /NOW\(\)/, 'o início do par usa o relógio do banco');
    assert.equal(insert.params.some((p) => p instanceof Date), false, 'nenhum Date do Node no início do par');
    const first = newMessage(100, 10, 'primeira', 1000);
    const res = await call('GET', '/api/messages/101', 11);
    assert.deepEqual(res.body.messages.map((m) => m.id), [first.id]);
    assert.ok(mission(100).pair_started_at && mission(101).pair_started_at, 'as duas missões ganham o início do par');
  });

  test('negado: Duo na mesma missão sem início de par mostra a conversa vazia (falha fechada)', async () => {
    Object.assign(mission(200), { partner_id: 22, pair_started_at: null });
    newMessage(200, 22, 'cheguei');
    for (const user of [20, 22]) {
      const res = await call('GET', '/api/messages/200', user);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.messages, [], `pessoa ${user}`);
    }
  });

  test('negado: falha no fim do par não deixa bloqueio pela metade', async () => {
    db.failEnd = true;
    const res = await block(100, 10);
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Não deu para bloquear agora. Tente de novo daqui a pouco.');
    assert.deepEqual(db.blocks, [], 'o bloqueio foi desfeito junto');
    assert.equal(db.matches[0].status, 'active');
    assert.equal(mission(100).partner_id, 11);
    assert.equal(mission(101).partner_id, 10);
    assert.equal(consoleCalls.length, 0);
    // E dá para tentar de novo.
    db.failEnd = false;
    assert.equal((await block(100, 10)).status, 200);
    assert.deepEqual(db.blocks, [{ blocker_id: 10, blocked_id: 11 }]);
  });

  test('Duo na mesma missão: quem é parceiro bloqueia; o dono fica com a missão em Solo', async () => {
    const res = await block(200, 21);
    assert.equal(res.status, 200);
    assert.deepEqual(db.blocks, [{ blocker_id: 21, blocked_id: 20 }]);
    assert.equal(mission(200).user_id, 20);
    assert.equal(mission(200).mode, 'solo');
    assert.equal(mission(200).partner_id, null);
    const owner = await call('GET', '/api/messages/200', 20);
    assert.deepEqual(owner.body.messages, [], 'a conversa some também para o dono');
  });

  test('negado: não dá para bloquear quem não é o seu par', async () => {
    const solo = await block(300, 30);
    assert.equal(solo.status, 400);
    assert.equal(solo.body.error, 'Você só pode bloquear a pessoa que está no seu par agora.');
    assert.equal((await block(100, 30)).status, 403, 'missão de outra pessoa');
    assert.equal((await block(200, 10)).status, 403);
    assert.equal((await block('abc', 10)).status, 403);
    assert.equal(db.blocks.length, 0);
    assert.equal(db.matches[0].status, 'active');
  });

  test('negado: depois do bloqueio não há como reabrir o par', async () => {
    await block(100, 10);
    // Bloquear de novo: já não há par.
    assert.equal((await block(100, 10)).status, 400);
    // Enviar mensagem: sem par ativo.
    const send = await call('POST', '/api/messages', 11, { mission_id: 101, content: 'oi de novo' });
    assert.equal(send.status, 400);
    // Pedir par de novo (os dois voltam a querer Duo): o juntador não os junta.
    mission(100).match_preference = 'parceiro';
    mission(101).match_preference = 'parceiro';
    assert.equal(await tryMatchMission(mission(100), 10, pool), null);
    assert.equal(await tryMatchMission(mission(101), 11, pool), null);
    assert.equal(db.matches.filter((mm) => mm.status === 'active').length, 0);
  });

  test('controle: sem bloqueio, o juntador junta os mesmos dois (o teste acima mede algo)', async () => {
    db.matches[0].status = 'ended';
    for (const id of [100, 101]) Object.assign(mission(id), { mode: 'solo', partner_id: null, match_preference: 'parceiro' });
    const result = await tryMatchMission(mission(100), 10, pool);
    assert.ok(result);
    assert.equal(result.partnerMission.user_id, 11);
  });

  test('o bloqueio impede o par também quando quem pede é quem foi bloqueado', async () => {
    db.blocks.push({ blocker_id: 11, blocked_id: 10 });
    db.matches[0].status = 'ended';
    for (const id of [100, 101]) Object.assign(mission(id), { mode: 'solo', partner_id: null, match_preference: 'parceiro' });
    assert.equal(await tryMatchMission(mission(100), 10, pool), null);
  });

  // ---------- Denunciar ----------
  test('denunciar uma mensagem do par: 201, e a equipe vê só trecho e motivo', async () => {
    const res = await report(1, 11, { reason: 'ofensa', details: 'foi grosseiro' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { reported: true, message: 'Obrigado. Sua denúncia foi registrada.' });
    const admin = await call('GET', '/api/messages/admin/reports', ADMIN);
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.reports, [{
      id: 1, message_id: 1, excerpt: 'oi do dez', reason: 'ofensa', reason_label: 'Ofensa ou ataque a alguém',
      details: 'foi grosseiro', created_at: '2026-11-23T18:00:00.000Z'
    }]);
    const raw = JSON.stringify(admin.body);
    assert.equal(/reporter|sender|nao-deveria-sair|pessoa/.test(raw), false, 'sem nome nem id de quem denunciou');
  });

  test('no Duo da mesma missão, o parceiro denuncia o dono', async () => {
    assert.equal((await report(4, 21, { reason: 'spam' })).status, 201);
  });

  test('negado: não dá para denunciar mensagem de outra conversa nem a própria', async () => {
    assert.equal((await report(1, 30)).status, 404, 'quem não está na conversa');
    assert.equal((await report(3, 10)).status, 404, 'mensagem de outro Duo');
    assert.equal((await report(5, 10)).status, 404);
    assert.equal((await report(999, 11)).status, 404);
    assert.equal((await report('abc', 11)).status, 404);
    const own = await report(1, 10);
    assert.equal(own.status, 400);
    assert.equal(own.body.error, 'Você não pode denunciar a sua própria mensagem.');
    assert.equal(db.reports.length, 0);
  });

  test('negado: depois do bloqueio, a mensagem do outro lado já não é desta conversa', async () => {
    await block(100, 10);
    assert.equal((await report(2, 10)).status, 404);
  });

  test('negado: motivo fora da lista, comentário que não é texto ou longo demais', async () => {
    assert.equal((await report(1, 11, { reason: 'chato' })).status, 400);
    assert.equal((await report(1, 11, { reason: 'ofensa', details: 42 })).status, 400);
    const long = await report(1, 11, { reason: 'ofensa', details: 'a'.repeat(281) });
    assert.equal(long.status, 400);
    assert.equal(long.body.error, 'O comentário passou de 280 caracteres. Encurte um pouco e envie de novo.');
    assert.equal(db.reports.length, 0);
  });

  test('negado: denúncia dupla dá 409 e a cota de 10 por dia dá 429', async () => {
    assert.equal((await report(1, 11)).status, 201);
    const again = await report(1, 11);
    assert.equal(again.status, 409);
    assert.equal(again.body.already_reported, true);
    for (let i = 0; i < 9; i++) db.reports.push({ id: 100 + i, message_id: 1000 + i, reporter_id: 11, reason: 'spam' });
    db.messages.push({ id: 6, mission_id: 100, sender_id: 10, content: 'outra' });
    const quota = await report(6, 11);
    assert.equal(quota.status, 429);
    assert.equal(quota.body.error, 'Você já fez 10 denúncias nas últimas 24 horas. Tente de novo amanhã.');
  });

  test('crise no comentário: a denúncia vale, o comentário não é guardado nem logado', async () => {
    const res = await report(1, 11, { reason: 'ofensa', details: 'quero morrer' });
    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(res.body.reported, true);
    assert.equal(db.reports[0].details, null);
    assert.equal(db.queries.some((q) => q.params.some((p) => typeof p === 'string' && p.includes('quero morrer'))), false);
    assert.equal(consoleCalls.length, 0);
  });

  test('crise no comentário de uma denúncia recusada: a pessoa vê a ajuda', async () => {
    const res = await report(3, 10, { reason: 'ofensa', details: 'quero morrer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.reported, false);
    assert.equal(db.reports.length, 0);
  });

  // ---------- Login e admin ----------
  test('negado: sem login (401) em bloquear, denunciar e na lista da equipe', async () => {
    assert.equal((await block(100)).status, 401);
    assert.equal((await report(1)).status, 401);
    assert.equal((await call('GET', '/api/messages/admin/reports')).status, 401);
    assert.equal(db.blocks.length + db.reports.length, 0);
  });

  test('negado: só o admin vê as denúncias', async () => {
    await report(1, 11);
    const res = await call('GET', '/api/messages/admin/reports', 11);
    assert.equal(res.status, 403);
    assert.equal(res.body.reports, undefined);
  });

  // ---------- Antes da 011 ----------
  test('antes da 011: bloquear dá 503 e o par continua; denunciar e a lista dão 503', async () => {
    db.migrated = false;
    const res = await block(100, 10);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'O bloqueio ainda não está disponível. Tente de novo mais tarde.');
    assert.equal(db.matches[0].status, 'active', 'o par não acaba sem o registro do bloqueio');
    assert.equal(mission(100).partner_id, 11);
    assert.equal((await report(1, 11)).status, 503);
    assert.equal((await call('GET', '/api/messages/admin/reports', ADMIN)).status, 503);
    // Crise no comentário antes da 011: a ajuda aparece mesmo assim.
    assert.equal((await report(1, 11, { reason: 'ofensa', details: 'quero morrer' })).body.crisis, true);
  });

  test('antes da 011: a conversa abre normalmente e o juntador não quebra', async () => {
    db.migrated = false;
    const res = await call('GET', '/api/messages/100', 10);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages.map((m) => m.id).sort(), [1, 2]);
    db.matches[0].status = 'ended';
    for (const id of [100, 101]) Object.assign(mission(id), { mode: 'solo', partner_id: null, match_preference: 'parceiro' });
    assert.ok(await tryMatchMission(mission(100), 10, pool));
  });
});

describe('exclusão de conta com as tabelas do chat (011)', () => {
  test('os passos novos vêm antes das mensagens e são opcionais', () => {
    const names = ACCOUNT_DELETION_STEPS.map((s) => s.name);
    const at = (name) => names.indexOf(name);
    assert.ok(at('denuncias_de_mensagens') >= 0 && at('bloqueios_do_chat') >= 0);
    assert.ok(at('denuncias_de_mensagens') < at('mensagens'), 'as denúncias saem antes das mensagens');
    assert.equal(ACCOUNT_DELETION_STEPS[at('denuncias_de_mensagens')].optional, true);
    assert.equal(ACCOUNT_DELETION_STEPS[at('bloqueios_do_chat')].optional, true);
    const blocksSql = normalize(ACCOUNT_DELETION_STEPS[at('bloqueios_do_chat')].sql);
    assert.match(blocksSql, /blocker_id = \$1 OR blocked_id = \$1/);
  });

  test('antes da 011, a exclusão segue (SAVEPOINT); outro erro derruba a exclusão', async () => {
    const seen = [];
    const fake = (failCode) => ({
      query: async (sql) => {
        const text = normalize(sql);
        seen.push(text);
        if (/^DELETE FROM (message_reports|user_blocks)/.test(text)) throw Object.assign(new Error('x'), { code: failCode });
        return { rows: [], rowCount: 0 };
      }
    });
    const counts = await deleteAccountData(fake('42P01'), 7);
    assert.equal(counts.denuncias_de_mensagens, 0);
    assert.equal(counts.conta, 0);
    assert.ok(seen.includes('ROLLBACK TO SAVEPOINT passo_opcional'));
    assert.ok(seen.includes('DELETE FROM users WHERE id = $1'), 'a exclusão chega ao fim');
    await assert.rejects(() => deleteAccountData(fake('23503'), 7), 'outro erro não é engolido');
  });
});

test('011: só acrescenta, registra a versão e explica a volta', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '011_chat_blocks_and_reports.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(code.replace(/ON DELETE CASCADE/g, ''), /\b(DROP|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
  assert.match(code, /CREATE TABLE IF NOT EXISTS user_blocks/);
  assert.match(code, /CREATE TABLE IF NOT EXISTS message_reports/);
  assert.match(code, /UNIQUE \(blocker_id, blocked_id\)/);
  assert.match(code, /UNIQUE \(message_id, reporter_id\)/);
  assert.match(code, /char_length\(details\) <= 280/);
  assert.match(code, /'011_chat_blocks_and_reports'/);
  assert.match(sql, /Para voltar atrás/);
  assert.match(sql, /NÃO APLICAR/);
});
