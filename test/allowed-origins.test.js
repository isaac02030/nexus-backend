const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAllowedOrigins } = require('../lib/allowed-origins');

test('localhost:8080 so entra fora de producao', () => {
  const production = buildAllowedOrigins('production');
  const development = buildAllowedOrigins('development');

  assert.equal(production.has('http://localhost:8080'), false);
  assert.equal(development.has('http://localhost:8080'), true);
  assert.equal(buildAllowedOrigins('test').has('http://localhost:8080'), true);
  assert.equal(buildAllowedOrigins('').has('http://localhost:8080'), true);

  assert.equal(production.has('https://isaac02030.github.io'), true);
  assert.equal(production.has('http://localhost:5173'), true);
  assert.equal(development.has('https://isaac02030.github.io'), true);
});
