// POST /api/vertice/notify-all usa só a chave própria (VERTICE_SECRET).
// Antes: VERTICE_SECRET || JWT_SECRET. Agora o JWT_SECRET nunca abre esta porta.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');

const JWT = 'jwt-de-teste-'.padEnd(40, 'a1b2c3d4e5');
const VERTICE = 'vertice-de-teste-'.padEnd(40, 'f6g7h8i9j0');
let queries = 0;
let server;
let baseUrl;

// Corpo com o texto de uma novidade (a rota agora só manda novidades).
const NEWS = JSON.stringify({ title: 'Novidade de teste', body: 'Texto de teste.' });

function request(headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/vertice/notify-all', baseUrl);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(NEWS);
  });
}

describe('chave do notify-all', () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', async () => { queries += 1; return { rows: [] }; });
    const app = express();
    app.use(express.json());
    app.use('/api/vertice', require('../routes/vertice'));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    mock.restoreAll();
  });

  beforeEach(() => {
    queries = 0;
    process.env.JWT_SECRET = JWT;
    process.env.VERTICE_SECRET = VERTICE;
  });

  test('chave certa: passa', async () => {
    const res = await request({ 'x-vertice-secret': VERTICE });
    assert.equal(res.status, 200);
    assert.equal(queries, 1);
  });

  test('negado: o JWT_SECRET não abre esta porta', async () => {
    const res = await request({ 'x-vertice-secret': JWT });
    assert.equal(res.status, 401);
    assert.equal(queries, 0);
  });

  test('negado: sem cabeçalho ou chave errada', async () => {
    assert.equal((await request()).status, 401);
    assert.equal((await request({ 'x-vertice-secret': `${VERTICE}x` })).status, 401);
    assert.equal(queries, 0);
  });

  test('negado: sem VERTICE_SECRET, fica desligado (mesmo mandando o JWT_SECRET)', async () => {
    delete process.env.VERTICE_SECRET;
    const res = await request({ 'x-vertice-secret': JWT });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /VERTICE_SECRET/);
    assert.equal(queries, 0);
  });

  test('negado: VERTICE_SECRET igual ao JWT_SECRET, fica desligado', async () => {
    process.env.VERTICE_SECRET = JWT;
    const res = await request({ 'x-vertice-secret': JWT });
    assert.equal(res.status, 503);
    assert.equal(queries, 0);
  });
});
