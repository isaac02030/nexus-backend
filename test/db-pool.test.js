// Um Pool só para o servidor inteiro (lib/db.js), com fechamento limpo.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';
process.env.DATABASE_POOL_MAX = '3';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');

// Conta quantos Pools nascem. Troca antes de carregar lib/db e as rotas.
const created = [];
const RealPool = pg.Pool;
pg.Pool = class CountingPool extends RealPool {
  constructor(options) {
    super(options);
    created.push(options);
  }
};

const routesDir = path.join(__dirname, '..', 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
for (const file of routeFiles) require(path.join(routesDir, file));
const { db, closeDb } = require('../lib/db');

test('todas as rotas juntas abrem um Pool só', () => {
  assert.ok(routeFiles.length >= 11, 'esperava as 11 rotas');
  assert.equal(created.length, 1);
});

test('o tamanho vem de DATABASE_POOL_MAX', () => {
  assert.equal(created[0].max, 3);
  assert.equal(db.options.max, 3);
});

test('nenhum arquivo do servidor cria Pool por conta própria (só lib/db.js)', () => {
  const root = path.join(__dirname, '..');
  const files = [
    ...routeFiles.map(f => path.join('routes', f)),
    ...fs.readdirSync(path.join(root, 'lib')).map(f => path.join('lib', f)),
    'server.js',
    'vertice.js'
  ].filter(f => f.endsWith('.js') && f !== path.join('lib', 'db.js'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /new\s+Pool\s*\(|new\s+Client\s*\(/, file);
  }
});

test('as rotas não mudam a estrutura do banco (sem DDL em tempo de execução)', () => {
  for (const file of routeFiles) {
    const text = fs.readFileSync(path.join(routesDir, file), 'utf8');
    assert.doesNotMatch(text, /\b(ALTER|CREATE|DROP|TRUNCATE)\s+(TABLE|INDEX|SCHEMA|ROLE)\b/i, file);
  }
});

test('conexão parada que cai não derruba o processo (há ouvinte de erro)', () => {
  assert.ok(db.listenerCount('error') >= 1);
});

test('closeDb fecha o Pool uma vez só', async () => {
  let ends = 0;
  const originalEnd = db.end.bind(db);
  db.end = async () => { ends += 1; return originalEnd(); };
  const a = closeDb();
  const b = closeDb();
  assert.equal(a, b);
  await a;
  assert.equal(ends, 1);
  assert.equal(db.ended, true);
});
