// Excluir a conta num Postgres DE VERDADE, local e descartável.
// Pulado sem ACCOUNT_DELETION_TEST_DATABASE_URL apontando para um banco
// local chamado nexus_account_deletion_test (o teste APAGA o esquema dele).
// Roda as migrações e scripts/sql/papel-do-app.sql; o app usa o nexus_app.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dbUrl = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || '';
const localTestDb = /nexus_account_deletion_test/.test(dbUrl)
  && /localhost|127\.0\.0\.1|\/var\/run\/postgresql|host=\//.test(dbUrl);

const repoRoot = path.join(__dirname, '..');
const PASSWORD = 'senha-de-teste-123';
const A = 2; const B = 3; const C = 4; const D = 5; const E = 6;
const TABLES = ['users', 'missions', 'mission_matches', 'checkins', 'messages', 'notification_log',
  'push_subscriptions', 'communities', 'community_members', 'community_posts', 'community_post_reports',
  'community_missions', 'community_mission_participants'];

function psqlFile(file) {
  execFileSync('psql', [dbUrl, '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q',
    '-c', 'SET client_min_messages TO warning', '-f', file], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('excluir a conta no Postgres: Duo passa ao parceiro, solo sai inteiro', {
  skip: localTestDb ? false : 'Defina ACCOUNT_DELETION_TEST_DATABASE_URL para um Postgres local descartável (nexus_account_deletion_test).',
  timeout: 60000
}, async (t) => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  t.after(async () => { try { await admin.end(); } catch (_) { /* nada */ } });

  await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
  await admin.query('CREATE SCHEMA public');
  for (const f of ['001_initial_schema.sql', '002_user_reminder.sql', '003_checkin_difficult_day.sql',
    '004_mission_weekdays.sql', '005_community_post_reports.sql', '006_user_adult_confirmation.sql']) {
    psqlFile(path.join(repoRoot, 'migrations', f));
  }
  psqlFile(path.join(repoRoot, 'scripts', 'sql', 'papel-do-app.sql'));

  const appUrl = new URL(dbUrl);
  appUrl.username = 'nexus_app';
  appUrl.password = '';
  process.env.DATABASE_URL = appUrl.toString();
  process.env.DATABASE_SSL = 'disable';
  process.env.JWT_SECRET = 'teste-apenas-local';
  process.env.NODE_ENV = 'test';

  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { db } = require('../lib/db');
  const { TRANSFERRED_MISSION_TITLE } = require('../lib/account-deletion');
  t.after(async () => { try { await db.end(); } catch (_) { /* nada */ } });

  const app = express();
  app.use(express.json());
  app.use('/api/users', require('../routes/users'));
  app.use('/api/checkins', require('../routes/checkins'));
  const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
  async function call(method, p, { tok, body } = {}) {
    const r = await fetch(base + p, {
      method,
      headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json() };
  }

  // ---- dados falsos ----
  const q = (sql, p) => admin.query(sql, p);
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const [id, name] of [[1, 'admin'], [A, 'alfa'], [B, 'beta'], [C, 'gama'], [D, 'delta'], [E, 'epsilon']]) {
    await q(`INSERT INTO users (id, username, email, password, bio, adult_confirmed_at, reminder_time, timezone)
             VALUES ($1,$2,$3,$4,$5,NOW(),'08:00','Europe/Lisbon')`, [id, name, `${name}@exemplo.test`, hash, `bio-${name}`]);
  }
  await q("SELECT setval('users_id_seq', 10)");
  const mission = (id, owner, partner, mode, x = {}) => q(
    `INSERT INTO missions (id, user_id, partner_id, title, category, description, daily_minimum, commitment_window,
       why_it_matters, fallback_plan, study_focus, study_current_stage, study_target_outcome, proof_mode, mode, status,
       started_at, partner_started_at, user_score, partner_score, user_contact, partner_contact, merged_into_id)
     VALUES ($1,$2,$3,$4,'habito',$5,$6,$7,$8,$9,$10,$11,$12,'self_report',$13,'active',
       NOW() - INTERVAL '1 day', $14, $15, $16, $17, $18, $19)`,
    [id, owner, partner, `titulo-${id}`, `descricao-${id}`, `minimo-${id}`, `janela-${id}`, `porque-${id}`,
      `plano-${id}`, `foco-${id}`, `etapa-${id}`, `objetivo-${id}`, mode,
      x.partnerStarted || null, x.userScore || 0, x.partnerScore || 0, x.uc || null, x.pc || null, x.merged || null]);
  await mission(10, A, B, 'parceiro', { uc: 'contato-A-10', pc: 'contato-B-10', userScore: 1, partnerScore: 1, partnerStarted: new Date() });
  await mission(11, B, A, 'parceiro', { uc: 'contato-B-11', pc: 'contato-A-11' });
  // Par por mission_matches como routes/missions.js grava: partner_id nas
  // DUAS missões (achado do Argos no PR 26).
  await mission(12, A, C, 'rival');
  await mission(13, C, A, 'rival');
  await mission(14, C, null, 'solo', { merged: 12 });
  await mission(18, C, D, 'parceiro');
  await mission(19, A, null, 'solo');
  await mission(20, C, null, 'rival');
  await mission(30, E, null, 'solo');
  // Par encerrado em que a missão de A ainda tem partner_id (dado antigo):
  // também não pode passar ao outro.
  await mission(21, A, D, 'parceiro');
  await mission(22, D, A, 'parceiro');
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode) VALUES (12, 13, 'rival')`);
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, status, ended_at) VALUES (19, 18, 'parceiro', 'ended', NOW())`);
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode) VALUES (20, 12, 'rival')`);
  await q("UPDATE mission_matches SET status = 'ended' WHERE mission_a_id = 20");
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, status, ended_at) VALUES (21, 22, 'parceiro', 'ended', NOW())`);
  const ck = (mid, uid, note) => q(`INSERT INTO checkins (mission_id, user_id, day_number, completed, note) VALUES ($1,$2,1,true,$3)`, [mid, uid, note]);
  await ck(10, A, 'nota-A-10'); await ck(10, B, 'nota-B-10'); await ck(11, A, 'nota-A-11'); await ck(11, B, 'nota-B-11');
  await ck(12, A, 'nota-A-12'); await ck(13, C, 'nota-C-13'); await ck(30, E, 'nota-E-30');
  const msg = (mid, uid, text) => q(`INSERT INTO messages (mission_id, sender_id, content) VALUES ($1,$2,$3)`, [mid, uid, text]);
  await msg(10, A, 'msg-A-10'); await msg(10, B, 'msg-B-10'); await msg(11, A, 'msg-A-11'); await msg(11, B, 'msg-B-11');
  const nl = (uid, mid) => q(`INSERT INTO notification_log (user_id, mission_id, kind) VALUES ($1,$2,'x')`, [uid, mid]);
  await nl(A, 10); await nl(B, 10); await nl(A, 11); await nl(B, 11); await nl(E, 30);
  await q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,'endpoint-A','k','a'),($2,'endpoint-B','k','a'),($3,'endpoint-E','k','a')`, [A, B, E]);
  await q(`INSERT INTO communities (id, name, slug, description, category, created_by, member_count) VALUES (1,'comunidade-A','k1','descricao-A','habito',$1,2),(2,'comunidade-B','k2','descricao-B','habito',$2,2)`, [A, B]);
  await q(`INSERT INTO community_members (community_id, user_id) VALUES (1,$1),(1,$2),(2,$1),(2,$2)`, [A, B]);
  await q(`INSERT INTO community_posts (id, community_id, user_id, content) VALUES (1,2,$1,'post-A'),(2,2,$2,'post-B')`, [A, B]);
  await q(`INSERT INTO community_post_reports (post_id, reporter_id, reason, details) VALUES (1,$1,'spam','denuncia-sobre-A'),(2,$2,'outro','denuncia-A')`, [B, A]);
  await q(`INSERT INTO community_missions (id, community_id, title, description, mode, created_by) VALUES (1,2,'cm-A','cm-desc-A','x',$1)`, [A]);
  await q(`INSERT INTO community_mission_participants (community_mission_id, user_id) VALUES (1,$1),(1,$2)`, [A, B]);

  async function dump() {
    const out = {};
    for (const table of TABLES) {
      out[table] = (await q(`SELECT row_to_json(x)::text AS j FROM ${table} x ORDER BY 1`)).rows.map(r => r.j);
    }
    return out;
  }
  const one = async (sql, p) => (await q(sql, p)).rows[0];

  // ---- casos negados ----
  const before = JSON.stringify(await dump());
  const wrong = await call('DELETE', '/api/users/me', { tok: token(A), body: { password: 'errada' } });
  assert.equal(wrong.status, 403);
  const other = await call('DELETE', '/api/users/me', { tok: token(B), body: { password: 'errada' } });
  assert.equal(other.status, 403);
  const adminTry = await call('DELETE', '/api/users/me', { tok: token(1), body: { password: PASSWORD } });
  assert.equal(adminTry.status, 403);
  assert.equal(JSON.stringify(await dump()), before, 'casos negados mudaram o banco');

  // ---- A sai (dono de Duo, parceiro em Duo, Rival por par, solo) ----
  const m10Before = await one('SELECT started_at FROM missions WHERE id = 10');
  const missionsOf = async (id) => (await q('SELECT id FROM missions WHERE user_id = $1 ORDER BY id', [id])).rows.map(r => r.id);
  const cBefore = await missionsOf(C);
  const dBefore = await missionsOf(D);
  const ok = await call('DELETE', '/api/users/me', { tok: token(A), body: { password: PASSWORD } });
  assert.equal(ok.status, 200);

  // Duo, dono sai: a missão passa ao parceiro, sem o contrato de quem saiu.
  const m10 = await one('SELECT * FROM missions WHERE id = 10');
  assert.equal(m10.user_id, B);
  assert.equal(m10.partner_id, null);
  assert.equal(m10.mode, 'solo');
  assert.equal(m10.title, TRANSFERRED_MISSION_TITLE);
  for (const field of ['description', 'daily_minimum', 'commitment_window', 'why_it_matters', 'fallback_plan',
    'study_focus', 'study_current_stage', 'study_target_outcome', 'partner_contact', 'partner_started_at',
    'pair_started_at', 'match_preference']) {
    assert.equal(m10[field], null, `missão 10: ${field}`);
  }
  assert.equal(m10.user_contact, 'contato-B-10');
  assert.equal(m10.user_score, 1);
  assert.equal(m10.partner_score, 0);
  assert.equal(m10.category, 'habito');
  assert.equal(m10.proof_mode, 'self_report');
  assert.equal(m10.started_at.getTime(), m10Before.started_at.getTime(), 'started_at não pode mudar');
  const m10Checkins = (await q('SELECT user_id, note FROM checkins WHERE mission_id = 10')).rows;
  assert.deepEqual(m10Checkins, [{ user_id: B, note: 'nota-B-10' }]);
  const m10Messages = (await q('SELECT sender_id, content FROM messages WHERE mission_id = 10')).rows;
  assert.deepEqual(m10Messages, [{ sender_id: B, content: 'msg-B-10' }]);
  assert.equal((await one('SELECT COUNT(*)::int n FROM notification_log WHERE mission_id = 10')).n, 1);

  // O parceiro segue usando a missão sem contrato: lê e faz check-in.
  const progress = await call('GET', '/api/checkins/10', { tok: token(B) });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.progress[B].checkins[0].note, 'nota-B-10');
  const checkin = await call('POST', '/api/checkins', { tok: token(B), body: { mission_id: 10, note: 'dia dois' } });
  assert.equal(checkin.status, 201, JSON.stringify(checkin.body));
  assert.equal(checkin.body.checkin.day_number, 2);

  // A era parceira na missão de B: fica para B, solo.
  const m11 = await one('SELECT * FROM missions WHERE id = 11');
  assert.equal(m11.user_id, B);
  assert.equal(m11.partner_id, null);
  assert.equal(m11.partner_contact, null);
  assert.equal(m11.mode, 'solo');
  assert.equal(m11.title, 'titulo-11');

  // Par ativo por mission_matches: o outro lado fica coerente (solo).
  const m13 = await one('SELECT * FROM missions WHERE id = 13');
  assert.equal(m13.partner_id, null);
  assert.equal(m13.mode, 'solo');
  // Par ENCERRADO não mexe na missão do outro, que está em outro par.
  const m18 = await one('SELECT * FROM missions WHERE id = 18');
  assert.equal(m18.mode, 'parceiro');
  assert.equal(m18.partner_id, D);
  const m20 = await one('SELECT * FROM missions WHERE id = 20');
  assert.equal(m20.mode, 'rival');

  // Caso negado do par: a missão de A no par NÃO passa a C nem a D. Cada um
  // fica exatamente com as missões que já tinha (nenhuma «Missão sem título»).
  assert.deepEqual(await missionsOf(C), cBefore);
  assert.deepEqual(await missionsOf(D), dBefore);
  assert.equal((await one('SELECT COUNT(*)::int n FROM missions WHERE title = $1', [TRANSFERRED_MISSION_TITLE])).n, 1);
  assert.equal((await one('SELECT COUNT(*)::int n FROM missions WHERE user_id = $1 AND status = $2', [C, 'active'])).n, cBefore.length);
  const m22 = await one('SELECT * FROM missions WHERE id = 22');
  assert.equal(m22.partner_id, null);
  assert.equal(m22.mode, 'solo');

  // Missões só de A (e as do par) saem inteiras; fusão não fica órfã; nenhum par sobra.
  assert.equal((await one('SELECT COUNT(*)::int n FROM missions WHERE id IN (12, 19, 21)')).n, 0);
  assert.equal((await one('SELECT merged_into_id FROM missions WHERE id = 14')).merged_into_id, null);
  assert.equal((await one('SELECT COUNT(*)::int n FROM mission_matches')).n, 0);

  // Nada aponta para A; nenhum texto de A sobra (fora a comunidade criada por A).
  const after = await dump();
  for (const table of TABLES) {
    for (const j of after[table]) {
      const row = JSON.parse(j);
      for (const k of ['user_id', 'partner_id', 'sender_id', 'reporter_id', 'created_by']) {
        assert.notEqual(row[k], A, `${table}.${k} ainda aponta para a conta apagada`);
      }
      if (table === 'users') assert.notEqual(row.id, A);
      if (table !== 'communities' && table !== 'community_missions') {
        for (const s of ['-A', 'alfa', 'denuncia-sobre-A', 'titulo-12', 'titulo-19', 'titulo-21', 'porque-10']) assert.ok(!j.includes(s), `${table}: sobrou ${s}`);
      }
    }
  }
  const joined = JSON.stringify(after);
  for (const s of ['nota-B-11', 'msg-B-11', 'nota-C-13', 'post-B', 'endpoint-B', 'nota-E-30']) assert.ok(joined.includes(s), `sumiu ${s}`);
  assert.equal((await one('SELECT member_count FROM communities WHERE id = 2')).member_count, 1);
  assert.equal((await one('SELECT created_by FROM communities WHERE id = 1')).created_by, null);

  // Depois: login falha e o token antigo não vale.
  const login = await call('POST', '/api/users/login', { body: { email: 'alfa@exemplo.test', password: PASSWORD } });
  assert.equal(login.status, 401);
  const reuse = await call('GET', '/api/checkins/10', { tok: token(A) });
  assert.equal(reuse.status, 401);

  // ---- E sai (só solo): tudo de E some, nada dos outros muda ----
  const othersBefore = await dump();
  const okE = await call('DELETE', '/api/users/me', { tok: token(E), body: { password: PASSWORD } });
  assert.equal(okE.status, 200);
  const afterE = await dump();
  for (const table of TABLES) {
    const expected = othersBefore[table].filter(j => {
      const row = JSON.parse(j);
      return !(row.user_id === E || row.id === (table === 'users' ? E : -1) || row.mission_id === 30 || (table === 'missions' && row.id === 30));
    });
    assert.deepEqual(afterE[table], expected, `${table} mudou além de E`);
  }
});
