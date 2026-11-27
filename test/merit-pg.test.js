// Mérito no Postgres real (PR D, achado do Argos): Rival e par por
// mission_matches não somam a missão do outro; Duo conta para os dois.
// Pulado sem MERIT_TEST_DATABASE_URL apontando para um banco LOCAL e
// descartável (nexus_merit_test; o esquema é recriado). Banco próprio: o
// node --test roda os arquivos em paralelo, e o teste da exclusão de conta
// recria o esquema do banco dele.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const dbUrl = process.env.MERIT_TEST_DATABASE_URL || '';
const localTestDb = /nexus_merit_test/.test(dbUrl)
  && /localhost|127\.0\.0\.1|\/var\/run\/postgresql|host=\//.test(dbUrl);
const repoRoot = path.join(__dirname, '..');

test('Postgres: missão do rival não é da pessoa (mérito, post e rolagem); Duo conta para os dois', {
  skip: localTestDb ? false : 'Defina MERIT_TEST_DATABASE_URL para um Postgres local descartável (nexus_merit_test).',
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

  // ---- A missão do rival não libera o post nem a rolagem (mesma regra) ----
  // rival1 (8) tem uma missão ATIVA de Mente, com todo dia sendo dia da missão
  // e sem check-in hoje. rival2 (9) tem a dele, de Corpo, só às segundas: hoje
  // pode ser dia livre para ela. partner_id cruzado, mode 'rival'.
  await q(`INSERT INTO users (id, username, email, password, adult_confirmed_at) VALUES
           (8,'ativo1','ativo1@exemplo.test','x',NOW()), (9,'ativo2','ativo2@exemplo.test','x',NOW())`);
  const todayIso = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', weekday: 'short' })
    .format(new Date()).replace(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/, (d) => ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[d]));
  const notToday = todayIso === 1 ? [2, 3, 4] : [todayIso % 7 + 1, (todayIso + 1) % 7 + 1, (todayIso + 2) % 7 + 1];
  await q(`INSERT INTO missions (user_id, partner_id, title, category, mode, status, area, started_at)
           VALUES (8, 9, 't', 'c', 'rival', 'active', 'mente', NOW() - INTERVAL '2 days')`);
  await q(`INSERT INTO missions (user_id, partner_id, title, category, mode, status, area, started_at, mission_weekdays)
           VALUES (9, 8, 't', 'c', 'rival', 'active', 'corpo', NOW() - INTERVAL '2 days', $1::smallint[])`, [notToday]);
  const corrida = (await q(`SELECT id FROM communities WHERE slug = 'corrida'`)).rows[0].id;
  await q(`INSERT INTO community_members (community_id, user_id) VALUES ($1, 8)`, [corrida]);
  await q(`INSERT INTO community_posts (community_id, user_id, content) VALUES ($1, 9, 'treino de hoje')`, [corrida]);
  const as8 = { Authorization: `Bearer ${jwt.sign({ userId: 8 }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' };
  const post = await fetch(`${base}/api/communities/corrida/posts`, { method: 'POST', headers: as8, body: JSON.stringify({ content: 'uma dica' }) });
  const postBody = await post.json();
  assert.equal(post.status, 403, 'a área da missão do rival não libera o post');
  assert.equal(postBody.code, 'other_area');
  const feed = await (await fetch(`${base}/api/communities/corrida/posts`, { headers: as8 })).json();
  assert.equal(feed.continuous_scroll, false, 'o dia livre do rival não libera a rolagem');
  assert.equal(feed.page_size, 10);
  // ---- Par por mission_matches CONCLUÍDO (o par segue 'active', cruzado): 1 para cada ----
  await q(`INSERT INTO users (id, username, email, password, adult_confirmed_at) VALUES
           (10,'pa','pa@exemplo.test','x',NOW()), (11,'pb','pb@exemplo.test','x',NOW()),
           (12,'dono2','dono2@exemplo.test','x',NOW()), (13,'antigo','antigo@exemplo.test','x',NOW()),
           (14,'novo','novo@exemplo.test','x',NOW())`);
  const ma = await mission(10, 11, 'parceiro');
  const mb = await mission(11, 10, 'parceiro');
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, status) VALUES ($1, $2, 'parceiro', 'active')`, [ma, mb]);
  assert.deepEqual([await count(10), await count(11)], [1, 1], 'par concluído não conta em dobro');

  // ---- Par antigo ENCERRADO com outra pessoa + Duo novo por convite ----
  // dono2 (12) teve par com antigo (13), encerrado (partner zerado); depois
  // novo (14) entrou por convite de Duo na MESMA missão.
  const antigo = (await q(`INSERT INTO missions (user_id, title, category, mode, status, duration_days)
                           VALUES (13, 't', 'c', 'solo', 'completed', 30) RETURNING id`)).rows[0].id;
  const doneDuo = await mission(12, 14, 'parceiro');
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, status) VALUES ($1, $2, 'parceiro', 'ended')`, [doneDuo, antigo]);
  assert.deepEqual([await count(12), await count(13), await count(14)], [1, 1, 1], 'o parceiro novo conta 1');
  // Versão ativa: o parceiro novo posta (área da missão) e rola (dia livre dela).
  const antigoAtiva = (await q(`INSERT INTO missions (user_id, title, category, mode, status)
                                VALUES (13, 't', 'c', 'solo', 'active') RETURNING id`)).rows[0].id;
  const duoAtivo = (await q(`INSERT INTO missions (user_id, partner_id, title, category, mode, status, area, started_at, mission_weekdays)
                             VALUES (12, 14, 't', 'c', 'parceiro', 'active', 'corpo', NOW() - INTERVAL '2 days', $1::smallint[]) RETURNING id`, [notToday])).rows[0].id;
  await q(`INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, status) VALUES ($1, $2, 'parceiro', 'ended')`, [duoAtivo, antigoAtiva]);
  await q(`INSERT INTO community_members (community_id, user_id) VALUES ($1, 14)`, [corrida]);
  const as14 = { Authorization: `Bearer ${jwt.sign({ userId: 14 }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' };
  const post14 = await fetch(`${base}/api/communities/corrida/posts`, { method: 'POST', headers: as14, body: JSON.stringify({ content: 'treino feito' }) });
  assert.equal(post14.status, 201, 'o parceiro do Duo novo posta');
  const feed14 = await (await fetch(`${base}/api/communities/corrida/posts`, { headers: as14 })).json();
  assert.equal(feed14.continuous_scroll, true, 'o parceiro do Duo novo rola (dia livre da missão do Duo)');

  // Controle: a própria rival2, em dia livre, ganha a rolagem.
  const as9 = { Authorization: `Bearer ${jwt.sign({ userId: 9 }, process.env.JWT_SECRET)}` };
  const own = await (await fetch(`${base}/api/communities/corrida/posts`, { headers: as9 })).json();
  assert.equal(own.continuous_scroll, true, 'o dia livre da própria missão libera');
});
