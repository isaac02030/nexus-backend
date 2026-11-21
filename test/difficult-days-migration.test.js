const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('a migração 003 só acrescenta is_difficult com padrão falso', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations', '003_checkin_difficult_day.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS is_difficult BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.doesNotMatch(code, /\bDROP\b/i);
  assert.doesNotMatch(code, /\bUPDATE\b/i);
  assert.doesNotMatch(code, /\bDELETE\b/i);
  assert.match(sql, /003_checkin_difficult_day/);
});

test('database.sql aplica 001, 002, 003 e 004 nessa ordem', () => {
  const bootstrap = fs.readFileSync(path.join(root, 'database.sql'), 'utf8');
  const order = [...bootstrap.matchAll(/\\ir migrations\/(\d{3}_[a-z0-9_]+\.sql)/g)].map(match => match[1]);
  assert.deepEqual(order, [
    '001_initial_schema.sql',
    '002_user_reminder.sql',
    '003_checkin_difficult_day.sql',
    '004_mission_weekdays.sql'
  ]);
});
