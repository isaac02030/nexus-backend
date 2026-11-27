// Maratona no Postgres real (PR E): 1 maratona aberta por pessoa em cada
// comunidade (decisão de 27/11), com corrida; criar de novo depois que a
// anterior terminou; entrar continua sem limite.
// Pulado sem MARATHON_TEST_DATABASE_URL apontando para um banco LOCAL e
// descartável (nexus_marathon_test; o esquema é recriado).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const dbUrl = process.env.MARATHON_TEST_DATABASE_URL || '';
const localTestDb = /nexus_marathon_test/.test(dbUrl)
  && /localhost|127\.0\.0\.1|\/var\/run\/postgresql|host=\//.test(dbUrl);
const repoRoot = path.join(__dirname, '..');

test('Postgres: 1 maratona aberta por pessoa e comunidade, com corrida; depois de terminar, cria outra', {
  skip: localTestDb ? false : 'Defina MARATHON_TEST_DATABASE_URL para um Postgres local descartável (nexus_marathon_test).',
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
  t.after(async () => { try { await db.end(); } catch (_) { /* nada */ } });

  const q = (sql, p) => admin.query(sql, p);
  for (const id of [1, 2]) {
    await q(`INSERT INTO users (id, username, email, password, adult_confirmed_at) VALUES ($1, $2, $3, 'x', NOW())`,
      [id, `u${id}`, `u${id}@exemplo.test`]);
    await q(`INSERT INTO missions (user_id, title, category, status, area, started_at) VALUES ($1, 't', 'c', 'active', 'mente', NOW())`, [id]);
  }
  const leitura = (await q(`SELECT id FROM communities WHERE slug = 'leitura'`)).rows[0].id;
  const estudos = (await q(`SELECT id FROM communities WHERE slug = 'estudos'`)).rows[0].id;
  for (const c of [leitura, estudos]) {
    for (const u of [1, 2]) await q('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [c, u]);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/community-missions', require('../routes/community-missions'));
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, user, body) => {
    const r = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json() };
  };
  const body = (title) => ({ title, description: 'Uma página', duration_days: 7, max_participants: 10 });
  const mine = async (user, c) => (await q(
    `SELECT COUNT(*)::int AS n FROM community_missions WHERE created_by = $1 AND community_id = $2`, [user, c])).rows[0].n;

  // Corrida: dois pedidos ao mesmo tempo da mesma pessoa na mesma comunidade.
  const race = await Promise.all([call('POST', '/api/community-missions/leitura', 1, body('A')), call('POST', '/api/community-missions/leitura', 1, body('B'))]);
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await mine(1, leitura), 1);
  const refused = race.find((r) => r.status === 409);
  assert.equal(refused.body.code, 'open_marathon');
  assert.equal(refused.body.error, 'Você já tem uma maratona aberta nesta comunidade. Quando ela terminar, você pode criar outra.');

  // Negado: uma futura também conta como aberta.
  const created = race.find((r) => r.status === 201).body.marathon;
  await q(`UPDATE community_missions SET start_day = (NOW() AT TIME ZONE 'Europe/Lisbon')::date + 3 WHERE id = $1`, [created.id]);
  assert.equal((await call('POST', '/api/community-missions/leitura', 1, body('C'))).status, 409);

  // Em outra comunidade, pode. E outra pessoa, na mesma, também.
  assert.equal((await call('POST', '/api/community-missions/estudos', 1, body('D'))).status, 201);
  assert.equal((await call('POST', '/api/community-missions/leitura', 2, body('E'))).status, 201);

  // Entrar continua sem limite: 1 entra na maratona de 2 e 2 na de 1.
  const of2 = (await q(`SELECT id FROM community_missions WHERE created_by = 2`)).rows[0].id;
  assert.equal((await call('POST', `/api/community-missions/leitura/${of2}/join`, 1)).status, 201);
  assert.equal((await call('POST', `/api/community-missions/leitura/${created.id}/join`, 2)).status, 201);

  // Depois que a anterior termina (ontem foi o último dia), cria outra.
  await q(`UPDATE community_missions SET start_day = (NOW() AT TIME ZONE 'Europe/Lisbon')::date - 7 WHERE id = $1`, [created.id]);
  const again = await call('POST', '/api/community-missions/leitura', 1, body('F'));
  assert.equal(again.status, 201);
  assert.equal(await mine(1, leitura), 2);

  // E o último dia ainda conta como aberta: com a nova terminando hoje, recusa.
  await q(`UPDATE community_missions SET start_day = (NOW() AT TIME ZONE 'Europe/Lisbon')::date - 6 WHERE id = $1`, [again.body.marathon.id]);
  assert.equal((await call('POST', '/api/community-missions/leitura', 1, body('G'))).status, 409);
});
