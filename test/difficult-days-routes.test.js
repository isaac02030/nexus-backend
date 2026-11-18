const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const {
  DIFFICULT_CONSECUTIVE_MESSAGE,
  DIFFICULT_LIMIT_MESSAGE
} = require('../lib/difficult-days');

const repoRoot = path.join(__dirname, '..');
const dbUrl = process.env.DIFFICULT_TEST_DATABASE_URL || '';
const localTestDb = /nexus_difficult_test/.test(dbUrl)
  && /localhost|127\.0\.0\.1|\/var\/run\/postgresql/.test(dbUrl);
const JWT_SECRET = 'teste-jwt-nao-e-segredo-real';
const SCORE_FIELDS = [
  'streak',
  'total',
  'today_done',
  'brio',
  'consistency',
  'recovered',
  'missed_yesterday',
  'missed_days',
  'recovery_needed'
];

function applyMigration(filename) {
  execFileSync('psql', [
    dbUrl,
    '--no-psqlrc',
    '-v', 'ON_ERROR_STOP=1',
    '-q',
    '-c', 'SET client_min_messages TO warning',
    '-f', path.join(repoRoot, 'migrations', filename)
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function request(port, options) {
  const payload = options.body == null ? null : JSON.stringify(options.body);
  const headers = {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: options.method,
      path: options.path,
      headers
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (raw) {
          try {
            json = JSON.parse(raw);
          } catch (err) {
            json = { raw };
          }
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: dbUrl,
      JWT_SECRET,
      TZ: 'UTC',
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  child.logs = () => logs.slice(-2000);
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitForReady(port, child) {
  const deadline = Date.now() + 8000;
  let lastError = '';

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Servidor encerrou antes de responder.\n${child.logs()}`);
    }
    try {
      const res = await request(port, { method: 'GET', path: '/' });
      if (res.status === 200) return;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Servidor nao ficou pronto. ${lastError}\n${child.logs()}`);
}

function pickScore(body) {
  const picked = {};
  for (const key of SCORE_FIELDS) picked[key] = body[key];
  return picked;
}

test('migration, dias difíceis e sequência no Postgres local', {
  skip: localTestDb
    ? false
    : 'Defina DIFFICULT_TEST_DATABASE_URL para um Postgres local descartavel (nexus_difficult_test).',
  timeout: 30000
}, async (t) => {
  const client = new Client({ connectionString: dbUrl });
  let child;
  let userId;
  let otherUserId;

  t.after(async () => {
    if (child) await stopChild(child);
    try {
      if (userId) await client.query('DELETE FROM users WHERE id = $1', [userId]);
      if (otherUserId) await client.query('DELETE FROM users WHERE id = $1', [otherUserId]);
    } catch (err) {
      // A limpeza nao pode esconder a falha do teste.
    }
    try {
      await client.end();
    } catch (err) {
      // O cliente pode nem ter conectado.
    }
  });

  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  applyMigration('001_initial_schema.sql');

  const username = `dificil_${Date.now()}`;
  const inserted = await client.query(
    `INSERT INTO users (username, email, password)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [username, `${username}@example.com`, 'teste-hash-nao-e-senha']
  );
  userId = inserted.rows[0].id;

  const other = await client.query(
    `INSERT INTO users (username, email, password)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`${username}_b`, `${username}_b@example.com`, 'teste-hash-nao-e-senha']
  );
  otherUserId = other.rows[0].id;

  const legacyStarted = new Date().toISOString();
  const legacy = await client.query(
    `INSERT INTO missions (user_id, title, category, status, duration_days, started_at)
     VALUES ($1, 'Missao antiga', 'habito', 'active', 30, $2::timestamptz AT TIME ZONE 'UTC')
     RETURNING id`,
    [userId, legacyStarted]
  );
  await client.query(
    `INSERT INTO checkins (mission_id, user_id, day_number, completed)
     VALUES ($1, $2, 1, true)`,
    [legacy.rows[0].id, userId]
  );

  applyMigration('003_checkin_difficult_day.sql');
  applyMigration('003_checkin_difficult_day.sql');

  const columns = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'checkins'
       AND column_name = 'is_difficult'`
  );
  assert.equal(columns.rows.length, 1);
  assert.equal(columns.rows[0].data_type, 'boolean');
  assert.equal(columns.rows[0].is_nullable, 'NO');
  assert.match(columns.rows[0].column_default, /false/);

  const legacyRow = await client.query(
    `SELECT completed, is_difficult
     FROM checkins
     WHERE mission_id = $1 AND user_id = $2 AND day_number = 1`,
    [legacy.rows[0].id, userId]
  );
  assert.deepEqual(legacyRow.rows[0], { completed: true, is_difficult: false });

  const version = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM schema_migrations
     WHERE version = '003_checkin_difficult_day'`
  );
  assert.equal(version.rows[0].total, 1);

  const port = await freePort();
  child = startServer(port);
  await waitForReady(port, child);
  const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });

  async function createMission(todayDay) {
    const started = new Date(Date.now() - (todayDay - 1) * 24 * 60 * 60 * 1000).toISOString();
    const mission = await client.query(
      `INSERT INTO missions (
         user_id, title, category, status, duration_days, started_at, daily_minimum
       )
       VALUES ($1, 'Missao de teste', 'habito', 'active', 30, $2::timestamptz AT TIME ZONE 'UTC', 'minimo do contrato')
       RETURNING id`,
      [userId, started]
    );
    return mission.rows[0].id;
  }

  async function seedDay(missionId, dayNumber, difficult, ownerId = userId) {
    await client.query(
      `INSERT INTO checkins (mission_id, user_id, day_number, completed, is_difficult)
       VALUES ($1, $2, $3, true, $4)`,
      [missionId, ownerId, dayNumber, difficult]
    );
  }

  function postCheckin(missionId, extra) {
    return request(port, {
      method: 'POST',
      path: '/api/checkins',
      token,
      body: { mission_id: missionId, ...extra }
    });
  }

  function getStreak(missionId) {
    return request(port, {
      method: 'GET',
      path: `/api/checkins/${missionId}/streak`,
      token
    });
  }

  function getCheckins(missionId) {
    return request(port, {
      method: 'GET',
      path: `/api/checkins/${missionId}`,
      token
    });
  }

  const normalMission = await createMission(2);
  const difficultMission = await createMission(2);
  await seedDay(normalMission, 1, false);
  await seedDay(difficultMission, 1, false);

  const normalPost = await postCheckin(normalMission, {});
  const difficultPost = await postCheckin(difficultMission, { difficult: true });
  assert.equal(normalPost.status, 201);
  assert.equal(normalPost.json.day, 2);
  assert.equal(normalPost.json.checkin.completed, true);
  assert.equal(normalPost.json.checkin.is_difficult, false);
  assert.equal(difficultPost.status, 201);
  assert.equal(difficultPost.json.day, 2);
  assert.equal(difficultPost.json.checkin.completed, true);
  assert.equal(difficultPost.json.checkin.is_difficult, true);

  const normalStreak = await getStreak(normalMission);
  const difficultStreak = await getStreak(difficultMission);
  assert.equal(normalStreak.status, 200);
  assert.equal(difficultStreak.status, 200);
  assert.deepEqual(pickScore(normalStreak.json), pickScore(difficultStreak.json));
  assert.equal(difficultStreak.json.streak, 2);
  assert.equal(difficultStreak.json.today_done, true);
  assert.deepEqual(difficultStreak.json.difficult_days, [2]);
  assert.equal(difficultStreak.json.difficult_days_used, 1);
  assert.equal(difficultStreak.json.difficult_days_remaining, 3);
  assert.deepEqual(normalStreak.json.difficult_days, []);
  assert.equal(normalStreak.json.difficult_days_used, 0);
  assert.equal(normalStreak.json.difficult_days_remaining, 4);

  const scores = await client.query(
    `SELECT id, user_score
     FROM missions
     WHERE id = ANY($1::int[])
     ORDER BY id`,
    [[normalMission, difficultMission]]
  );
  assert.deepEqual(scores.rows.map(row => row.user_score), [1, 1]);

  const listed = await getCheckins(difficultMission);
  assert.equal(listed.status, 200);
  const mine = listed.json.progress[String(userId)].checkins;
  assert.deepEqual(mine.map(item => item.difficult), [false, true]);

  const pairMission = await createMission(2);
  await seedDay(pairMission, 1, true);
  const second = await postCheckin(pairMission, { difficult: true });
  assert.equal(second.status, 201);
  assert.equal(second.json.checkin.is_difficult, true);
  const pairStreak = await getStreak(pairMission);
  assert.deepEqual(pairStreak.json.difficult_days, [1, 2]);
  assert.equal(pairStreak.json.difficult_days_used, 2);
  assert.equal(pairStreak.json.difficult_days_remaining, 2);
  assert.equal(pairStreak.json.streak, 2);

  const blockedMission = await createMission(3);
  await seedDay(blockedMission, 1, true);
  await seedDay(blockedMission, 2, true);
  const blocked = await postCheckin(blockedMission, { difficult: true });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.error, DIFFICULT_CONSECUTIVE_MESSAGE);
  const blockedCount = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM checkins
     WHERE mission_id = $1 AND day_number = 3`,
    [blockedMission]
  );
  assert.equal(blockedCount.rows[0].total, 0);
  const blockedStreak = await getStreak(blockedMission);
  assert.equal(blockedStreak.json.today_done, false);
  assert.equal(blockedStreak.json.streak, 0);
  assert.deepEqual(blockedStreak.json.difficult_days, [1, 2]);
  assert.equal(blockedStreak.json.difficult_days_remaining, 2);

  const gapMission = await createMission(4);
  await seedDay(gapMission, 1, true);
  await seedDay(gapMission, 2, true);
  await seedDay(gapMission, 3, false);
  const afterGap = await postCheckin(gapMission, { difficult: true });
  assert.equal(afterGap.status, 201);
  assert.equal(afterGap.json.checkin.completed, true);
  assert.equal(afterGap.json.checkin.is_difficult, true);
  const gapStreak = await getStreak(gapMission);
  assert.equal(gapStreak.json.streak, 4);
  assert.deepEqual(gapStreak.json.difficult_days, [1, 2, 4]);
  assert.equal(gapStreak.json.difficult_days_used, 3);
  assert.equal(gapStreak.json.difficult_days_remaining, 1);

  const samePattern = await createMission(4);
  await seedDay(samePattern, 1, true);
  await seedDay(samePattern, 2, true);
  await seedDay(samePattern, 3, false);
  const normalFourth = await postCheckin(samePattern, {});
  assert.equal(normalFourth.status, 201);
  const normalFourthStreak = await getStreak(samePattern);
  assert.deepEqual(pickScore(gapStreak.json), pickScore(normalFourthStreak.json));

  const fullMission = await createMission(8);
  await seedDay(fullMission, 1, true);
  await seedDay(fullMission, 3, true);
  await seedDay(fullMission, 5, true);
  await seedDay(fullMission, 7, true);
  const full = await postCheckin(fullMission, { difficult: true });
  assert.equal(full.status, 400);
  assert.equal(full.json.error, DIFFICULT_LIMIT_MESSAGE);
  const fullStreak = await getStreak(fullMission);
  assert.deepEqual(fullStreak.json.difficult_days, [1, 3, 5, 7]);
  assert.equal(fullStreak.json.difficult_days_used, 4);
  assert.equal(fullStreak.json.difficult_days_remaining, 0);
  assert.equal(fullStreak.json.today_done, false);

  const sharedMission = await createMission(1);
  await seedDay(sharedMission, 1, true, otherUserId);
  await seedDay(sharedMission, 3, true, otherUserId);
  await seedDay(sharedMission, 5, true, otherUserId);
  await seedDay(sharedMission, 7, true, otherUserId);
  const ownFirst = await postCheckin(sharedMission, { difficult: true });
  assert.equal(ownFirst.status, 201);
  const repeated = await postCheckin(sharedMission, { difficult: true });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.json.already_done, true);
  const sharedStreak = await getStreak(sharedMission);
  assert.deepEqual(sharedStreak.json.difficult_days, [1]);
  assert.equal(sharedStreak.json.difficult_days_used, 1);
  assert.equal(sharedStreak.json.difficult_days_remaining, 3);

  const plain = await postCheckin(await createMission(1), { difficult: false });
  assert.equal(plain.status, 201);
  assert.equal(plain.json.checkin.is_difficult, false);
  const asText = await postCheckin(await createMission(1), { difficult: 'true' });
  assert.equal(asText.status, 201);
  assert.equal(asText.json.checkin.is_difficult, false);
});
