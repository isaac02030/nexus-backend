const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const {
  BOTH_REQUIRED_MESSAGE,
  CHECKED_IN_ON_LOCAL_DATE_SQL,
  REMINDER_TIME_MESSAGE,
  TIMEZONE_MESSAGE
} = require('../lib/reminder-schedule');

const repoRoot = path.join(__dirname, '..');
const dbUrl = process.env.REMINDER_TEST_DATABASE_URL || '';
const localTestDb = /nexus_reminder_test/.test(dbUrl)
  && /localhost|127\.0\.0\.1|\/var\/run\/postgresql/.test(dbUrl);
const JWT_SECRET = 'teste-jwt-nao-e-segredo-real';

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
  const headers = { ...(options.extraHeaders || {}) };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.origin) headers.Origin = options.origin;

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
        resolve({ status: res.statusCode, json, headers: res.headers });
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
      // Banco local descartável: TLS desligado de forma explícita (só vale
      // com o banco nesta máquina; ver lib/db-config.js).
      DATABASE_SSL: 'disable',
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

test('migration, rotas e check-in no fuso', {
  skip: localTestDb
    ? false
    : 'Defina REMINDER_TEST_DATABASE_URL para um Postgres local descartavel (nexus_reminder_test).',
  timeout: 30000
}, async (t) => {
  const client = new Client({ connectionString: dbUrl });
  let child;
  let userId;

  t.after(async () => {
    if (child) await stopChild(child);
    try {
      if (userId) await client.query('DELETE FROM users WHERE id = $1', [userId]);
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

  const username = `lembrete_${Date.now()}`;
  const email = `${username}@example.com`;
  const inserted = await client.query(
    `INSERT INTO users (username, email, password)
     VALUES ($1, $2, $3)
     RETURNING id, username`,
    [username, email, 'teste-hash-nao-e-senha']
  );
  userId = inserted.rows[0].id;

  applyMigration('002_user_reminder.sql');
  applyMigration('002_user_reminder.sql');

  const columns = await client.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name IN ('reminder_time', 'timezone')
     ORDER BY column_name`
  );
  assert.deepEqual(columns.rows, [
    { column_name: 'reminder_time', data_type: 'time without time zone', is_nullable: 'YES' },
    { column_name: 'timezone', data_type: 'text', is_nullable: 'YES' }
  ]);

  const kept = await client.query(
    `SELECT username, reminder_time, timezone
     FROM users
     WHERE id = $1`,
    [userId]
  );
  assert.equal(kept.rows[0].username, username);
  assert.equal(kept.rows[0].reminder_time, null);
  assert.equal(kept.rows[0].timezone, null);

  const version = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM schema_migrations
     WHERE version = '002_user_reminder'`
  );
  assert.equal(version.rows[0].total, 1);

  const port = await freePort();
  child = startServer(port);
  await waitForReady(port, child);

  const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });

  const missingAuth = await request(port, { method: 'GET', path: '/api/users/me/reminder' });
  assert.equal(missingAuth.status, 401);

  const badToken = await request(port, {
    method: 'GET',
    path: '/api/users/me/reminder',
    token: 'token-invalido'
  });
  assert.equal(badToken.status, 403);

  const before = await request(port, {
    method: 'GET',
    path: '/api/users/me/reminder',
    token,
    origin: 'http://localhost:8080'
  });
  assert.equal(before.status, 200);
  assert.deepEqual(before.json, { reminder_time: null, timezone: null });
  assert.equal(before.headers['access-control-allow-origin'], 'http://localhost:8080');

  const preflight = await request(port, {
    method: 'OPTIONS',
    path: '/api/users/me/reminder',
    origin: 'http://localhost:8080',
    extraHeaders: {
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  assert.ok(preflight.status < 400);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:8080');

  const saved = await request(port, {
    method: 'PUT',
    path: '/api/users/me/reminder',
    token,
    origin: 'http://localhost:8080',
    body: { reminder_time: '08:30', timezone: 'America/Sao_Paulo' }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });

  const loaded = await request(port, {
    method: 'GET',
    path: '/api/users/me/reminder',
    token
  });
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.json, { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });

  const stored = await client.query(
    `SELECT to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone
     FROM users
     WHERE id = $1`,
    [userId]
  );
  assert.deepEqual(stored.rows[0], { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });

  const badTime = await request(port, {
    method: 'PUT',
    path: '/api/users/me/reminder',
    token,
    body: { reminder_time: '24:00', timezone: 'Europe/Lisbon' }
  });
  assert.equal(badTime.status, 400);
  assert.equal(badTime.json.error, REMINDER_TIME_MESSAGE);

  const badZone = await request(port, {
    method: 'PUT',
    path: '/api/users/me/reminder',
    token,
    body: { reminder_time: '08:30', timezone: 'America/Sao Paulo' }
  });
  assert.equal(badZone.status, 400);
  assert.equal(badZone.json.error, TIMEZONE_MESSAGE);

  const emptyBody = await request(port, {
    method: 'PUT',
    path: '/api/users/me/reminder',
    token,
    body: {}
  });
  assert.equal(emptyBody.status, 400);
  assert.equal(emptyBody.json.error, BOTH_REQUIRED_MESSAGE);

  const unchanged = await client.query(
    `SELECT to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone
     FROM users
     WHERE id = $1`,
    [userId]
  );
  assert.deepEqual(unchanged.rows[0], { reminder_time: '08:30', timezone: 'America/Sao_Paulo' });

  const mission = await client.query(
    `INSERT INTO missions (user_id, title, category, status, started_at)
     VALUES ($1, 'Missao de teste', 'habito', 'active', TIMESTAMP '2026-11-18 00:00:00')
     RETURNING id`,
    [userId]
  );
  await client.query(
    `INSERT INTO checkins (mission_id, user_id, day_number, completed, created_at)
     VALUES ($1, $2, 1, true, TIMESTAMP '2026-11-18 02:30:00')`,
    [mission.rows[0].id, userId]
  );

  async function checkedOn(zone, day) {
    const result = await client.query(CHECKED_IN_ON_LOCAL_DATE_SQL, [
      mission.rows[0].id,
      userId,
      zone,
      day
    ]);
    return result.rows.length === 1;
  }

  assert.equal(await checkedOn('America/Sao_Paulo', '2026-11-17'), true);
  assert.equal(await checkedOn('America/Sao_Paulo', '2026-11-18'), false);
  assert.equal(await checkedOn('Europe/Lisbon', '2026-11-18'), true);
  assert.equal(await checkedOn('Europe/Lisbon', '2026-11-17'), false);
});
