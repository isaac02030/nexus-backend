// Migrações 005 (denúncias) e 006 (idade): só acrescentam, nada apagam.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'migrations', name), 'utf8');
const code = (sql) => sql.replace(/--.*$/gm, '');

for (const name of ['005_community_post_reports.sql', '006_user_adult_confirmation.sql']) {
  test(`${name}: só acrescenta, registra a versão e explica a volta`, () => {
    const sql = read(name);
    // "ON DELETE CASCADE" é regra da chave, não apaga nada agora.
    assert.doesNotMatch(code(sql).replace(/ON DELETE CASCADE/g, ''), /\b(DROP|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.match(code(sql), new RegExp(`'${name.replace('.sql', '')}'`));
    assert.match(sql, /Para voltar atrás/);
    assert.match(code(sql), /^BEGIN;/m);
    assert.match(code(sql), /^COMMIT;/m);
  });
}

test('005: uma denúncia por pessoa por post, motivos da lista e 280 caracteres', () => {
  const sql = code(read('005_community_post_reports.sql'));
  assert.match(sql, /UNIQUE \(post_id, reporter_id\)/);
  assert.match(sql, /reason IN \('perigoso', 'ofensa', 'improprio', 'spam', 'outro'\)/);
  assert.match(sql, /char_length\(details\) <= 280/);
  assert.match(sql, /REFERENCES community_posts\(id\) ON DELETE CASCADE/);
  assert.match(sql, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /fast_track BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql, /hid_post_at TIMESTAMPTZ/);
});

test('005: a lista de motivos do banco é a mesma do servidor', () => {
  const { REASON_CODES } = require('../lib/post-reports');
  const sql = code(read('005_community_post_reports.sql'));
  const inList = /reason IN \(([^)]*)\)/.exec(sql)[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(inList, REASON_CODES);
});

test('006: guarda só a hora da confirmação, sem data de nascimento', () => {
  const sql = code(read('006_user_adult_confirmation.sql'));
  assert.match(sql, /ADD COLUMN IF NOT EXISTS adult_confirmed_at TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /birth/i);
});
