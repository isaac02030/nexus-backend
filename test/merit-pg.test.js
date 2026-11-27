// Mérito no Postgres real (PR D, achado do Argos): Rival e par por
// mission_matches não somam a missão do outro; Duo conta para os dois.
// Pulado sem ACCOUNT_DELETION_TEST_DATABASE_URL apontando para um banco
// LOCAL e descartável (o mesmo do teste da exclusão; o esquema é recriado).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const dbUrl = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || '';
const localTestDb = /nexus_account_deletion_test/.test(dbUrl)
  && /localhost|127\.0\.0\.1|\/var\/run\/postgresql|host=\//.test(dbUrl);
const repoRoot = path.join(__dirname, '..');

test('mérito no Postgres: Rival 1 para cada, Duo 1 para cada, par por mission_matches 1 para cada', {
  skip: localTestDb ? false : 'Defina ACCOUNT_DELETION_TEST_DATABASE_URL para um Postgres local descartável (nexus_account_deletion_test).',
  timeout: 60000
}, async (t) => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  t.after(async () => { try { await admin.end(); } catch (_) { /* nada */ } });
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
  await admin.query('CREATE SCHEMA public');
  const files = fs.readdirSync(path.join(repoRoot, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    execFileSync('psql', [dbUrl, '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-c', 'SET client_min_messages TO warning',
      '-f', path.join(repoRoot, 'migrations', f)], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.DATABASE_SSL = 'disable';
  process.env.JWT_SECRET = 'teste-apenas-local';
  process.env.NODE_ENV = 'test';
  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { db } = require('../lib/db');
  const { meritCountSql } = require('../lib/merit');
  t.after(async () => { try { await db.end(); } catch (_) { /* nada */ } });

  const q = (sql, p) => admin.query(sql, p);
  const names = ['rival1', 'rival2', 'dono', 'parceiro', 'par1', 'par2', 'solo'];
  for (let i = 0; i < names.length; i += 1) {
    await q(`INSERT INTO users (id, username, email, password, adult_confirmed_at) VALUES ($1,$2,$3,'x',NOW())`,
      [i + 1, names[i], `${names[i]}@exemplo.test`]);
  }
  const mission = async (user, partner, mode) => (await q(
    `INSERT INTO missions (user_id, partner_id, title, category, mode, status, duration_days)
     VALUES ($1, $2, 't', 'c', $3, 'completed', 30) RETURNING id`, [user, partner, mode])).rows[0].id;
  // Rival por convite (PR 38): cada um com a sua, partner_id cruzado, mode 'rival'.
  await mission(1, 2, 'rival');
  await mission(2, 1, 'rival');
  // Duo de verdade: uma missão só, dono e parceiro.
  await mission(3, 4, 'parceiro');
  // Par antigo por mission_matches (mode 'parceiro'), já encerrado: cada um com a sua.
  const a = await mission(5, 6, 'parceiro');
  const b = await mission(6, 5, 'parceiro');
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, status) VALUES ($1, $2, 'parceiro', 'ended')`, [a, b]);
  await mission(7, null, 'solo');

  const count = async (id) => (await q(`SELECT ${meritCountSql('u.id')} AS n FROM users u WHERE u.id = $1`, [id])).rows[0].n;
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5, 6, 7].map(count)), [1, 1, 1, 1, 1, 1, 1]);

  // O ranking (consulta agregada) dá o mesmo número.
  const c = (await q(`SELECT id FROM communities WHERE slug = 'leitura'`)).rows[0].id;
  for (let id = 1; id <= 7; id += 1) {
    await q(`INSERT INTO community_members (community_id, user_id, created_at) VALUES ($1, $2, NOW()::timestamp - ($3 * INTERVAL '1 minute'))`, [c, id, 100 - id]);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/communities', require('../routes/communities'));
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ranking = async (id) => (await (await fetch(`${base}/api/communities/leitura/ranking`, {
    headers: { Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}` }
  })).json());
  const r1 = await ranking(1);
  assert.deepEqual(r1.top.map((row) => [row.username, row.missions]), [['rival1', 1], ['rival2', 1], ['dono', 1]]);
  for (const id of [2, 4, 6]) {
    const r = await ranking(id);
    assert.equal(r.me.missions, 1, names[id - 1]);
    assert.equal(r.me.position, id, names[id - 1]); // empate: quem entrou antes vem antes
  }
});
