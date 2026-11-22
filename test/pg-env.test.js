// Scripts de backup: mesmas regras de TLS do servidor e senha fora da linha de comando.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pgEnv = path.join(__dirname, '..', 'scripts', 'pg-env.js');
function setup(env) {
  const code = `const { pgClientSetup } = require(${JSON.stringify(pgEnv)});
const r = pgClientSetup(process.env.DATABASE_URL);
console.log(JSON.stringify({ url: r.url, mode: r.env.PGSSLMODE, root: r.env.PGSSLROOTCERT || null, pass: r.env.PGPASSWORD || null }));
r.cleanup();`;
  return spawnSync(process.execPath, ['-e', code], {
    env: { PATH: process.env.PATH || '', ...env },
    encoding: 'utf8',
    timeout: 10000
  });
}

test('banco remoto: TLS verify-full e senha sai do endereço', () => {
  const res = setup({ DATABASE_URL: 'postgresql://app:senha-falsa@db.exemplo.invalid:5432/nexus?sslmode=verify-full' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.mode, 'verify-full');
  assert.equal(out.pass, 'senha-falsa');
  assert.ok(!out.url.includes('senha-falsa'));
  assert.ok(!out.url.includes('sslmode'));
  assert.equal(out.root, 'system');
});

test('negado: banco remoto sem TLS não faz backup', () => {
  const res = setup({ DATABASE_URL: 'postgresql://app:senha-falsa@db.exemplo.invalid/nexus?sslmode=disable' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /nesta máquina/);
  assert.ok(!res.stderr.includes('senha-falsa'));
});

test('banco local com TLS desligado de forma explícita', () => {
  const res = setup({ DATABASE_URL: 'postgresql://app@localhost:5432/nexus', DATABASE_SSL: 'disable' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).mode, 'disable');
});
