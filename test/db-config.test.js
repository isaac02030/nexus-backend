// Conexão com o banco: TLS obrigatório em produção, Pool pequeno.
// Só a função pura (lib/db-config.js): não abre conexão nenhuma.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPoolConfig, DEFAULT_POOL_MAX } = require('../lib/db-config');

const REMOTE = 'postgresql://app:senha-falsa-de-teste@db.exemplo.invalid:5432/nexus';
const LOCAL = 'postgresql://app:senha-falsa-de-teste@localhost:5432/nexus';
const prod = extra => ({ NODE_ENV: 'production', DATABASE_URL: REMOTE, ...extra });

function refuses(env, pattern) {
  assert.throws(() => buildPoolConfig(env), err => {
    assert.equal(err.name, 'DbConfigError');
    assert.match(err.message, pattern);
    // A mensagem nunca leva a senha nem o endereço.
    assert.doesNotMatch(err.message, /senha-falsa-de-teste|exemplo\.invalid/);
    return true;
  });
}

describe('TLS', () => {
  test('padrão: verify-full (cifra e confere o certificado)', () => {
    const { config, mode, warnings } = buildPoolConfig(prod());
    assert.equal(mode, 'verify-full');
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.deepEqual(warnings, []);
  });

  test('negado: produção com DATABASE_SSL=disable não conecta', () => {
    refuses(prod({ DATABASE_SSL: 'disable' }), /TLS desligado em produção/);
  });

  test('negado: produção com sslmode=disable ou ssl=false na URL', () => {
    refuses(prod({ DATABASE_URL: `${REMOTE}?sslmode=disable` }), /TLS desligado em produção/);
    refuses(prod({ DATABASE_URL: `${REMOTE}?ssl=false` }), /TLS desligado em produção/);
    refuses(prod({ DATABASE_URL: `${REMOTE}?ssl=0` }), /TLS desligado em produção/);
  });

  test('negado: produção sem TLS mesmo com o banco em localhost', () => {
    refuses(prod({ DATABASE_URL: LOCAL, DATABASE_SSL: 'disable' }), /TLS desligado em produção/);
  });

  test('negado: produção sem DATABASE_URL', () => {
    refuses({ NODE_ENV: 'production' }, /Falta DATABASE_URL/);
  });

  test('negado: sslmode prefer/allow (podem cair para sem TLS), em qualquer ambiente', () => {
    refuses({ DATABASE_URL: `${REMOTE}?sslmode=prefer` }, /sslmode=prefer/);
    refuses({ DATABASE_URL: `${REMOTE}?sslmode=allow` }, /sslmode=allow/);
    refuses(prod({ DATABASE_URL: `${REMOTE}?sslmode=prefer` }), /sslmode=prefer/);
  });

  test('negado: valores inválidos', () => {
    refuses({ DATABASE_SSL: 'talvez' }, /DATABASE_SSL não é válido/);
    refuses({ DATABASE_URL: `${REMOTE}?sslmode=qualquer` }, /sslmode da DATABASE_URL não é válido/);
  });

  test('negado: DATABASE_SSL e sslmode da URL diferentes', () => {
    refuses({ DATABASE_URL: `${REMOTE}?sslmode=require`, DATABASE_SSL: 'verify-full' }, /modos diferentes/);
  });

  test('desligar o TLS fora de produção: só explícito e só com o banco nesta máquina', () => {
    for (const url of [
      LOCAL,
      'postgresql://app@127.0.0.1:5432/nexus',
      'postgresql://app@[::1]:5432/nexus',
      'postgresql://app@localhost/nexus?host=/var/run/postgresql'
    ]) {
      const { config, mode } = buildPoolConfig({ NODE_ENV: 'development', DATABASE_URL: url, DATABASE_SSL: 'disable' });
      assert.equal(mode, 'disable', url);
      assert.equal(config.ssl, false, url);
    }
    // Sem pedir, mesmo local, o TLS continua ligado.
    assert.equal(buildPoolConfig({ DATABASE_URL: LOCAL }).mode, 'verify-full');
  });

  test('negado: desligar o TLS com banco em outro endereço (mesmo fora de produção)', () => {
    refuses({ NODE_ENV: 'development', DATABASE_URL: REMOTE, DATABASE_SSL: 'disable' }, /nesta máquina/);
    refuses({ DATABASE_URL: `${REMOTE}?sslmode=disable` }, /nesta máquina/);
    // host= da URL vale mais que o endereço: socket aponta para fora? Não; IP remoto, sim.
    refuses({ DATABASE_URL: `${LOCAL}?host=10.0.0.5`, DATABASE_SSL: 'disable' }, /nesta máquina/);
    refuses({ DATABASE_URL: `${REMOTE}?host=`, DATABASE_SSL: 'disable' }, /nesta máquina/);
  });

  test('require em produção é aceito, mas avisa', () => {
    const { config, warnings } = buildPoolConfig(prod({ DATABASE_SSL: 'require' }));
    assert.deepEqual(config.ssl, { rejectUnauthorized: false });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Prefira verify-full/);
  });

  test('verify-ca exige o certificado; DATABASE_SSL_CA aceita \\n numa linha só', () => {
    refuses(prod({ DATABASE_SSL: 'verify-ca' }), /DATABASE_SSL_CA/);
    const ca = '-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----';
    const { config } = buildPoolConfig(prod({ DATABASE_SSL: 'verify-ca', DATABASE_SSL_CA: ca }));
    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.equal(config.ssl.ca, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----');
    assert.equal(typeof config.ssl.checkServerIdentity, 'function');
    const full = buildPoolConfig(prod({ DATABASE_SSL_CA: ca })).config.ssl;
    assert.equal(full.ca.includes('\n'), true);
    assert.equal(full.checkServerIdentity, undefined);
  });

  test('os parâmetros de TLS saem da URL (o pg não pode trocar o modo em silêncio); o resto fica', () => {
    const { config, mode } = buildPoolConfig(prod({
      DATABASE_URL: `${REMOTE}?sslmode=verify-full&application_name=nexus&sslrootcert=/x.pem`
    }));
    assert.equal(mode, 'verify-full');
    assert.equal(config.connectionString, `${REMOTE}?application_name=nexus`);
    const plain = buildPoolConfig(prod({ DATABASE_URL: `${REMOTE}?ssl=true` })).config;
    assert.equal(plain.connectionString, REMOTE);
    assert.deepEqual(plain.ssl, { rejectUnauthorized: true });
  });
});

describe('tamanho do Pool', () => {
  test('padrão pequeno', () => {
    assert.equal(DEFAULT_POOL_MAX, 5);
    assert.equal(buildPoolConfig(prod()).config.max, 5);
  });

  test('DATABASE_POOL_MAX muda o tamanho', () => {
    assert.equal(buildPoolConfig(prod({ DATABASE_POOL_MAX: '8' })).config.max, 8);
  });

  test('negado: tamanho fora de 1 a 20 ou que não é número inteiro', () => {
    for (const bad of ['0', '21', '-1', '2.5', 'dez', '5abc']) {
      refuses(prod({ DATABASE_POOL_MAX: bad }), /DATABASE_POOL_MAX/);
    }
  });

  test('tempo limite para conectar e para conexão parada', () => {
    const { config } = buildPoolConfig(prod());
    assert.equal(config.connectionTimeoutMillis, 10000);
    assert.equal(config.idleTimeoutMillis, 30000);
  });
});
