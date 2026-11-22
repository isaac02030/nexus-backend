// Subida do servidor: segredos fortes e distintos, TLS no banco.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkStartupConfig, checkSecrets } = require('../lib/startup-config');

const strong = () => crypto.randomBytes(32).toString('hex');
const okProd = () => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:senha-falsa@db.exemplo.invalid:5432/nexus',
  JWT_SECRET: strong(),
  VERTICE_SECRET: strong()
});

describe('segredos em produção', () => {
  test('dois segredos fortes e distintos + TLS: sobe', () => {
    assert.deepEqual(checkStartupConfig(okProd()), { errors: [], warnings: [] });
  });

  test('negado: JWT_SECRET igual ao VERTICE_SECRET', () => {
    const env = okProd();
    env.VERTICE_SECRET = env.JWT_SECRET;
    const { errors } = checkStartupConfig(env);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /são iguais/);
    assert.ok(!errors[0].includes(env.JWT_SECRET), 'a mensagem não pode trazer o segredo');
  });

  test('negado: falta um dos segredos (sem usar o outro de reserva)', () => {
    const noVertice = okProd(); delete noVertice.VERTICE_SECRET;
    const noJwt = okProd(); delete noJwt.JWT_SECRET;
    assert.match(checkStartupConfig(noVertice).errors.join('\n'), /Falta VERTICE_SECRET/);
    assert.match(checkStartupConfig(noJwt).errors.join('\n'), /Falta JWT_SECRET/);
  });

  test('negado: segredo curto, repetitivo ou o texto de exemplo', () => {
    const short = okProd(); short.JWT_SECRET = 'abc123';
    const repeated = okProd(); repeated.VERTICE_SECRET = 'ab'.repeat(30);
    const placeholder = okProd(); placeholder.JWT_SECRET = 'troque-por-um-segredo-longo-e-aleatorio';
    assert.match(checkStartupConfig(short).errors.join('\n'), /JWT_SECRET é curto demais/);
    assert.match(checkStartupConfig(repeated).errors.join('\n'), /VERTICE_SECRET repete poucos caracteres/);
    assert.match(checkStartupConfig(placeholder).errors.join('\n'), /texto de exemplo/);
  });

  test('negado: produção sem TLS no banco', () => {
    const env = { ...okProd(), DATABASE_SSL: 'disable' };
    assert.match(checkStartupConfig(env).errors.join('\n'), /TLS desligado em produção/);
  });

  test('fora de produção, segredo fraco só avisa; banco mal configurado continua erro', () => {
    const dev = { NODE_ENV: 'development', JWT_SECRET: 'x', VERTICE_SECRET: 'x' };
    const result = checkStartupConfig(dev);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(w => /são iguais/.test(w)));
    const badDb = checkStartupConfig({ ...dev, DATABASE_URL: 'postgresql://a@db.exemplo.invalid/n', DATABASE_SSL: 'disable' });
    assert.match(badDb.errors.join('\n'), /nesta máquina/);
  });

  test('checkSecrets nunca devolve o valor de um segredo', () => {
    const secret = 'z'.repeat(5);
    const problems = checkSecrets({ JWT_SECRET: secret, VERTICE_SECRET: secret });
    for (const p of problems) assert.ok(!p.includes(secret));
  });
});

describe('server.js recusa subir em produção', () => {
  const run = env => spawnSync(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH || '', PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 10000
  });

  test('negado: segredos iguais (sai com 1 e não mostra o segredo)', () => {
    const env = okProd();
    env.VERTICE_SECRET = env.JWT_SECRET;
    const res = run(env);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /O servidor não vai subir/);
    assert.match(res.stderr, /são iguais/);
    assert.ok(!(res.stdout + res.stderr).includes(env.JWT_SECRET));
  });

  test('negado: TLS ausente (sslmode=disable) em produção', () => {
    const env = okProd();
    env.DATABASE_URL += '?sslmode=disable';
    const res = run(env);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /TLS desligado em produção/);
    assert.ok(!(res.stdout + res.stderr).includes('senha-falsa'));
  });
});
