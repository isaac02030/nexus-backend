// db:backup de banco fora desta máquina só sai cifrado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isLocalDatabaseUrl } = require('../lib/db-config');

const root = path.join(__dirname, '..');
const backupsDir = path.join(root, 'backups');
let fakeBin;
let marker;
let hadBackupsDir;

before(() => {
  hadBackupsDir = fs.existsSync(backupsDir);
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-falso-pg-'));
  marker = path.join(fakeBin, 'chamado');
  // pg_dump falso: só marca que foi chamado e falha (não cria backup).
  fs.writeFileSync(path.join(fakeBin, 'pg_dump'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
});

after(() => {
  fs.rmSync(fakeBin, { recursive: true, force: true });
  if (!hadBackupsDir) fs.rmSync(backupsDir, { recursive: true, force: true });
});

function runBackup(env) {
  fs.rmSync(marker, { force: true });
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'db-backup.js')], {
    cwd: root,
    env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`, ...env },
    encoding: 'utf8',
    timeout: 10000
  });
}

test('negado: banco remoto sem BACKUP_PASSPHRASE não faz backup (nem chama o pg_dump)', () => {
  const res = runBackup({ DATABASE_URL: 'postgresql://app:senha-falsa@db.exemplo.invalid:5432/nexus' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /precisa sair cifrado/);
  assert.match(res.stderr, /BACKUP_PASSPHRASE/);
  assert.ok(!(res.stdout + res.stderr).includes('senha-falsa'));
  assert.equal(fs.existsSync(marker), false, 'o pg_dump não pode ter sido chamado');
});

test('banco local sem frase segue (com aviso no fim) até o pg_dump', () => {
  const res = runBackup({ DATABASE_URL: 'postgresql://app@localhost:5432/nexus', DATABASE_SSL: 'disable' });
  assert.equal(fs.existsSync(marker), true, 'o pg_dump devia ter sido chamado');
  assert.doesNotMatch(res.stderr, /precisa sair cifrado/);
});

test('o que conta como banco nesta máquina', () => {
  for (const url of [
    'postgresql://a@localhost/n',
    'postgresql://a@127.0.0.1:5432/n',
    'postgresql://a@[::1]:5432/n',
    'postgresql://a@localhost/n?host=/var/run/postgresql'
  ]) assert.equal(isLocalDatabaseUrl(url), true, url);
  for (const url of [
    'postgresql://a@db.exemplo.invalid/n',
    'postgresql://a@10.0.0.5/n',
    'postgresql://a@localhost/n?host=db.exemplo.invalid',
    // host= vazio não pode transformar um endereço remoto em local.
    'postgresql://u:p@db.exemplo.invalid/db?host=',
    'postgresql://u:p@db.exemplo.invalid/db?host=%20'
  ]) assert.equal(isLocalDatabaseUrl(url), false, url);
});
