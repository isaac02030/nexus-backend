// Sair da comunidade: a pessoa sai só de si mesma (o id vem do token).
// Banco simulado; os casos negados provam que ninguém tira outra pessoa,
// que a dona não sai, que os posts ficam e que os dias da maratona contam.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const communitiesRouter = require('../routes/communities');

const app = express();
app.use(express.json());
app.use('/api/communities', communitiesRouter);

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

const st = {};
function reset() {
  st.queries = [];
  st.notAdult = new Set();
  st.communities = [
    { id: 3, slug: 'foco', name: 'Foco', created_by: null, member_count: 2, area: 'mente' },
    { id: 8, slug: 'alimentacao', name: 'Alimentação', created_by: null, member_count: 1, area: 'corpo' }
  ];
  st.members = new Set(['3:1', '3:2', '8:1']);
  st.participants = new Set(['40:1', '40:2']);
  st.missionCommunities = new Map([[40, 3]]);
  st.checkins = [{ mission: 40, user: 1, day: 2 }];
  st.failOnDelete = false;
  st.releases = 0;
}

const chave = (a, b) => `${a}:${b}`;

function handle(sql, params = []) {
  const text = normalize(sql);
  st.queries.push({ text, params });

  if (/adult_confirmed FROM users WHERE id = \$1$/.test(text)) {
    return { rows: [{ adult_confirmed: !st.notAdult.has(Number(params[0])) }] };
  }
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
  if (/^SELECT id, created_by FROM communities WHERE slug = \$1$/i.test(text)) {
    const c = st.communities.find((item) => item.slug === params[0]);
    return { rows: c ? [{ id: c.id, created_by: c.created_by }] : [] };
  }
  if (/^SELECT id FROM community_members WHERE community_id = \$1 AND user_id = \$2$/i.test(text)) {
    return { rows: st.members.has(chave(params[0], params[1])) ? [{ id: 1 }] : [] };
  }
  if (/^DELETE FROM community_mission_participants/i.test(text)) {
    let removed = 0;
    for (const k of [...st.participants]) {
      const [mission, user] = k.split(':');
      if (Number(user) === Number(params[0]) && st.missionCommunities.get(Number(mission)) === Number(params[1])) {
        st.participants.delete(k);
        removed += 1;
      }
    }
    return { rows: [], rowCount: removed };
  }
  if (/^DELETE FROM community_members/i.test(text)) {
    if (st.failOnDelete) throw new Error('banco indisponível');
    const k = chave(params[0], params[1]);
    const existed = st.members.has(k);
    st.members.delete(k);
    return { rows: [], rowCount: existed ? 1 : 0 };
  }
  if (/^UPDATE communities SET member_count = GREATEST\(member_count - 1, 0\)/i.test(text)) {
    const c = st.communities.find((item) => item.id === Number(params[0]));
    if (c) c.member_count = Math.max(0, c.member_count - 1);
    return { rows: [], rowCount: c ? 1 : 0 };
  }
  return { rows: [] };
}

const tokenFor = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
let server;
let baseUrl;

async function call(method, p, { token = tokenFor(1) } = {}) {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const raw = await r.text();
  return { status: r.status, body: raw ? JSON.parse(raw) : {} };
}

const fez = (padrao) => st.queries.some((q) => new RegExp(padrao, 'i').test(q.text));
const membro = (comunidade, pessoa) => st.members.has(chave(comunidade, pessoa));

describe('Sair da comunidade', { concurrency: 1 }, () => {
  before(async () => {
    reset();
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({
      query: async (sql, params) => handle(sql, params),
      release() { st.releases += 1; }
    }));
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => reset());

  test('membro sai: 200, contador cai, posts não são apagados', async () => {
    const res = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.left, true);
    assert.equal(res.body.removed, true);
    assert.equal(membro(3, 1), false);
    assert.equal(membro(3, 2), true);
    assert.equal(st.communities[0].member_count, 1);
    assert.equal(fez('^DELETE FROM community_posts\\b'), false);
    assert.equal(fez('^COMMIT$'), true);
  });

  test('negado: o pedido tira só quem pede; o id de outra pessoa nunca é usado', async () => {
    const res = await call('DELETE', '/api/communities/foco/members/me', { token: tokenFor(2) });
    assert.equal(res.status, 200);
    assert.equal(membro(3, 2), false);
    assert.equal(membro(3, 1), true);
    const apagou = st.queries.filter((q) => /^DELETE FROM community_members/i.test(q.text));
    assert.equal(apagou.length, 1);
    assert.deepEqual(apagou[0].params, [3, 2]);
    assert.equal(st.communities[0].member_count, 1);
  });

  test('negado: quem criou a comunidade não sai enquanto é a responsável: 409', async () => {
    st.communities[0].created_by = 1;
    const res = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'owner');
    assert.match(res.body.error, /cuida desta comunidade/i);
    assert.equal(membro(3, 1), true);
    assert.equal(st.communities[0].member_count, 2);
    assert.equal(fez('^DELETE FROM community_members'), false);
    assert.equal(fez('^ROLLBACK$'), true);
  });

  test('negado: quem não participa não pode sair: 403 e nada muda', async () => {
    st.members.delete('3:1');
    const res = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not_member');
    assert.equal(st.communities[0].member_count, 2);
    assert.equal(fez('^DELETE FROM community_members'), false);
  });

  test('negado: sem login 401; sem 18+ 403', async () => {
    const semLogin = await call('DELETE', '/api/communities/foco/members/me', { token: null });
    assert.equal(semLogin.status, 401);
    st.notAdult.add(1);
    const semIdade = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(semIdade.status, 403);
    assert.equal(semIdade.body.code, 'adult_confirmation_required');
    assert.equal(membro(3, 1), true);
    assert.equal(fez('^DELETE FROM community_members'), false);
  });

  test('negado: comunidade inexistente: 404', async () => {
    const res = await call('DELETE', '/api/communities/nao-existe/members/me');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Comunidade não encontrada.');
    assert.equal(fez('^DELETE FROM community_members'), false);
  });

  test('negado: segunda saída não baixa o contador de novo', async () => {
    const primeira = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(primeira.status, 200);
    const segunda = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(segunda.status, 403);
    assert.equal(segunda.body.code, 'not_member');
    assert.equal(st.communities[0].member_count, 1);
    assert.equal(fez('UPDATE communities SET member_count'), true);
    const atualizacoes = st.queries.filter((q) => /^UPDATE communities SET member_count/i.test(q.text));
    assert.equal(atualizacoes.length, 1);
  });

  test('Alimentação (só leitura) deixa sair normalmente', async () => {
    const res = await call('DELETE', '/api/communities/alimentacao/members/me');
    assert.equal(res.status, 200);
    assert.equal(membro(8, 1), false);
    assert.equal(st.communities[1].member_count, 0);
  });

  test('maratona: sai também da maratona, mas os dias marcados ficam contando', async () => {
    const res = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(res.status, 200);
    assert.equal(fez('^DELETE FROM community_mission_participants'), true);
    assert.equal(fez('^DELETE FROM community_marathon_checkins'), false);
    assert.equal(st.checkins.length, 1);
    assert.equal(st.checkins[0].user, 1);
  });

  test('negado: erro no banco desfaz a transação e não deixa meio caminho', async () => {
    st.failOnDelete = true;
    const res = await call('DELETE', '/api/communities/foco/members/me');
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Não deu para sair/i);
    assert.equal(fez('^ROLLBACK$'), true);
    assert.equal(fez('^COMMIT$'), false);
    assert.equal(membro(3, 1), true);
    assert.equal(st.releases > 0, true);
  });
});
