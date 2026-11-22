// Denúncia de posts, post escondido e moderação do admin (T3).
// Banco simulado: nada de banco real nem segredos.
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
const { HIDE_AFTER_REPORTS, pickHiddenReason, shouldHide, REASON_CODES } = require('../lib/post-reports');

const app = express();
app.use(express.json());
app.use('/api/communities', communitiesRouter);

const ADMIN = 1;
const AUTHOR = 2;

const db = {};

function resetDb() {
  db.communities = [
    { id: 3, slug: 'foco', name: 'Foco', category: 'estudo', member_count: 5 },
    { id: 4, slug: 'treino', name: 'Treino', category: 'academia', member_count: 1 }
  ];
  db.members = [];
  db.posts = [
    { id: 10, community_id: 3, user_id: AUTHOR, content: 'Dica do autor', created_at: '2026-11-21T10:00:00Z', hidden_at: null, hidden_reason: null, restored_at: null },
    { id: 11, community_id: 4, user_id: AUTHOR, content: 'Post de outra comunidade', created_at: '2026-11-21T10:00:00Z', hidden_at: null, hidden_reason: null, restored_at: null }
  ];
  db.reports = [];
  db.clock = 1000;
  db.queries = [];
  db.missingSchema = false;
  db.notAdult = new Set();
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function missing() {
  const err = new Error('relação não existe');
  err.code = '42P01';
  return err;
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };

  // 18+ confirmado no cadastro (todo mundo, menos quem está em notAdult).
  if (/adult_confirmed_at'\) IS NOT NULL AS adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !db.notAdult.has(Number(params[0])) }] };
  }

  if (/^SELECT \* FROM communities WHERE slug = \$1/i.test(text)) {
    const c = db.communities.find((item) => item.slug === params[0]);
    return { rows: c ? [{ ...c }] : [] };
  }

  if (/FROM community_members WHERE community_id = \$1 AND user_id = \$2/i.test(text)) {
    const m = db.members.find((item) =>
      item.community_id === Number(params[0]) && item.user_id === Number(params[1]));
    return { rows: m ? [{ ...m }] : [] };
  }

  // Post travado para a denúncia.
  if (/FROM community_posts WHERE id = \$1 AND community_id = \$2 FOR UPDATE/i.test(text)) {
    if (db.missingSchema) throw missing();
    const p = db.posts.find((item) => item.id === Number(params[0]) && item.community_id === Number(params[1]));
    return { rows: p ? [{ id: p.id, user_id: p.user_id, hidden_at: p.hidden_at, restored_at: p.restored_at }] : [] };
  }

  if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/i.test(text)) {
    return { rows: [{ id: Number(params[0]) }] };
  }

  // Cota de "perigoso" da pessoa nas últimas 24 horas (old = fora da janela).
  if (/FROM community_post_reports WHERE reporter_id = \$1 AND fast_track = true/i.test(text)) {
    if (db.missingSchema) throw missing();
    const total = db.reports.filter((r) => r.reporter_id === params[0] && r.fast_track && !r.old).length;
    return { rows: [{ total: String(total) }] };
  }

  if (/^INSERT INTO community_post_reports/i.test(text)) {
    if (db.missingSchema) throw missing();
    const [postId, reporterId, reason, details, fastTrack] = params;
    if (db.reports.some((r) => r.post_id === postId && r.reporter_id === reporterId)) {
      return { rows: [], rowCount: 0 };
    }
    db.clock += 1;
    db.reports.push({ post_id: postId, reporter_id: reporterId, reason, details, fast_track: fastTrack, hid_post_at: null, created_at: db.clock });
    return { rows: [{ id: db.reports.length }], rowCount: 1 };
  }

  if (/^UPDATE community_post_reports SET hid_post_at = NOW\(\)/i.test(text)) {
    db.clock += 1;
    let n = 0;
    for (const r of db.reports) {
      if (r.post_id !== params[0]) continue;
      if (params[1] != null && !(r.created_at > params[1])) continue;
      r.hid_post_at = db.clock;
      n += 1;
    }
    return { rows: [], rowCount: n };
  }

  if (/FROM community_post_reports WHERE post_id = \$1 AND/i.test(text) && /GROUP BY reason, fast_track/i.test(text)) {
    const since = params[1];
    const counts = new Map();
    for (const r of db.reports) {
      if (r.post_id !== params[0]) continue;
      if (since != null && !(r.created_at > since)) continue;
      const key = `${r.reason}|${r.fast_track}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return {
      rows: [...counts].map(([key, total]) => {
        const [reason, fast] = key.split('|');
        return { reason, fast_track: fast === 'true', total: String(total) };
      })
    };
  }

  if (/^UPDATE community_posts SET hidden_at = NOW\(\), hidden_reason = \$2/i.test(text)) {
    const p = db.posts.find((item) => item.id === params[0] && item.hidden_at == null);
    if (p) {
      db.clock += 1;
      p.hidden_at = db.clock;
      p.hidden_reason = params[1];
    }
    return { rows: [], rowCount: p ? 1 : 0 };
  }

  if (/^UPDATE community_posts SET hidden_at = NULL/i.test(text)) {
    if (db.missingSchema) throw missing();
    const p = db.posts.find((item) => item.id === params[0] && item.hidden_at != null);
    if (p) {
      db.clock += 1;
      p.hidden_at = null;
      p.hidden_reason = null;
      p.restored_at = db.clock;
    }
    return { rows: p ? [{ id: p.id }] : [], rowCount: p ? 1 : 0 };
  }

  if (/^SELECT id FROM community_posts WHERE id = \$1$/i.test(text)) {
    const p = db.posts.find((item) => item.id === params[0]);
    return { rows: p ? [{ id: p.id }] : [] };
  }

  if (/^DELETE FROM community_posts WHERE id = \$1/i.test(text)) {
    const before = db.posts.length;
    db.posts = db.posts.filter((item) => item.id !== params[0]);
    db.reports = db.reports.filter((r) => r.post_id !== params[0]);
    const n = before - db.posts.length;
    return { rows: n ? [{ id: params[0] }] : [], rowCount: n };
  }

  // Lista do admin.
  if (/WHERE cp\.hidden_at IS NOT NULL/i.test(text)) {
    if (db.missingSchema) throw missing();
    const rows = db.posts.filter((p) => p.hidden_at != null).map((p) => ({
      id: p.id,
      community_id: p.community_id,
      community_slug: db.communities.find((c) => c.id === p.community_id).slug,
      user_id: p.user_id,
      username: `pessoa${p.user_id}`,
      content: p.content,
      created_at: p.created_at,
      hidden_at: p.hidden_at,
      hidden_reason: p.hidden_reason,
      reports: db.reports.filter((r) => r.post_id === p.id)
        .map((r) => ({ reason: r.reason, details: r.details, created_at: r.created_at })),
      urgent: db.reports.some((r) => r.post_id === p.id && r.reason === params[0]),
      // Alguém que contou para esconder este post escondeu >= params[1]
      // posts nas últimas 24 horas (oldHide = fora da janela).
      repeat_reporter_alert: db.reports.some((r) => r.post_id === p.id && r.hid_post_at != null
        && new Set(db.reports
          .filter((x) => x.reporter_id === r.reporter_id && x.hid_post_at != null && !x.oldHide)
          .map((x) => x.post_id)).size >= params[1])
    }));
    // ORDER BY urgent DESC, hidden_at ASC
    rows.sort((a, b) => (Number(b.urgent) - Number(a.urgent)) || (a.hidden_at - b.hidden_at));
    return { rows };
  }

  // GET /:slug: comunidade com acesso.
  if (/FROM communities c/i.test(text) && /WHERE c\.slug = \$2/i.test(text)) {
    const c = db.communities.find((item) => item.slug === params[1]);
    if (!c) return { rows: [] };
    const isMember = db.members.some((m) => m.community_id === c.id && m.user_id === Number(params[0]));
    return { rows: [{ ...c, is_member: isMember, missions_done: 1, total_days: 10 }] };
  }

  if (/FROM community_members cm JOIN users u/i.test(text)) return { rows: [] };

  // GET /:slug: feed. Imita o WHERE e o SELECT do servidor.
  if (/FROM community_posts cp JOIN users u/i.test(text)) {
    const viewer = Number(params[1]);
    const rows = db.posts
      .filter((p) => p.community_id === Number(params[0]))
      .filter((p) => p.hidden_at == null || p.user_id === viewer)
      .map((p) => ({
        id: p.id,
        community_id: p.community_id,
        user_id: p.user_id,
        content: p.content,
        created_at: p.created_at,
        username: `pessoa${p.user_id}`,
        hidden: p.hidden_at != null,
        hidden_reason: p.user_id === viewer ? p.hidden_reason : null
      }));
    return { rows };
  }

  return { rows: [] };
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

function addMember(userId, communityId = 3) {
  db.members.push({ community_id: communityId, user_id: userId });
}

function report(userId, { postId = 10, slug = 'foco', reason = 'spam', details, token } = {}) {
  const body = { reason };
  if (details !== undefined) body.details = details;
  return request('POST', `/api/communities/${slug}/posts/${postId}/report`, {
    token: token === undefined ? tokenFor(userId) : token, body
  });
}

function textReachedDb(fragment) {
  return db.queries.some((q) => q.params.some((p) => typeof p === 'string' && p.includes(fragment)));
}

let server;
let baseUrl;
const consoleCalls = [];

async function request(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { 'Content-Type': 'application/json' })
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : {} };
}

describe('comunidade: denúncia, post escondido e moderação', { concurrency: 1 }, () => {
  before(async () => {
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({
      query: async (sql, params) => handle(sql, params),
      release() {}
    }));
    for (const name of ['log', 'error', 'warn', 'info']) {
      mock.method(console, name, (...args) => { consoleCalls.push(args); });
    }
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetDb();
    consoleCalls.length = 0;
  });

  // ---------- regras ----------

  test('N = 3 pessoas diferentes; "perigoso" esconde com 1', () => {
    assert.equal(HIDE_AFTER_REPORTS, 3);
    assert.equal(shouldHide([{ reason: 'spam', total: '2' }]), false);
    assert.equal(shouldHide([{ reason: 'spam', total: '2' }, { reason: 'ofensa', total: '1' }]), true);
    assert.equal(shouldHide([{ reason: 'perigoso', fast_track: true, total: '1' }]), true);
    // "perigoso" fora da cota vale como comum.
    assert.equal(shouldHide([{ reason: 'perigoso', fast_track: false, total: '1' }]), false);
    assert.equal(shouldHide([{ reason: 'perigoso', fast_track: false, total: '1' }, { reason: 'spam', total: '2' }]), true);
    assert.equal(pickHiddenReason([{ reason: 'spam', total: '2' }, { reason: 'perigoso', fast_track: true, total: '1' }]), 'perigoso');
    assert.equal(pickHiddenReason([{ reason: 'spam', total: '2' }, { reason: 'perigoso', fast_track: false, total: '1' }]), 'spam');
  });

  test('motivo escondido: o mais citado; no empate, o mais grave', () => {
    assert.equal(pickHiddenReason([{ reason: 'spam', total: '2' }, { reason: 'ofensa', total: '1' }]), 'spam');
    assert.equal(pickHiddenReason([{ reason: 'spam', total: '1' }, { reason: 'perigoso', total: '1' }, { reason: 'outro', total: '1' }]), 'perigoso');
    assert.deepEqual(REASON_CODES, ['perigoso', 'ofensa', 'improprio', 'spam', 'outro']);
  });

  // ---------- denunciar ----------

  test('membro denuncia: 201 e a denúncia fica com motivo e comentário', async () => {
    addMember(5);
    const res = await report(5, { reason: 'ofensa', details: '  ataque pessoal  ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.reported, true);
    assert.equal(res.body.crisis, undefined);
    assert.deepEqual(db.reports.map((r) => [r.post_id, r.reporter_id, r.reason, r.details]),
      [[10, 5, 'ofensa', 'ataque pessoal']]);
    assert.equal(res.body.hidden, undefined, 'não conta para quem denuncia se escondeu');
  });

  test('negado: sem login (401) e nada gravado', async () => {
    const res = await report(5, { token: null });
    assert.equal(res.status, 401);
    assert.equal(db.reports.length, 0);
  });

  test('negado: não membro (403) e nada gravado', async () => {
    const res = await report(6);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Só membros/);
    assert.equal(db.reports.length, 0);
  });

  test('negado: membro de outra comunidade não denuncia aqui', async () => {
    addMember(6, 4);
    const res = await report(6);
    assert.equal(res.status, 403);
    assert.equal(db.reports.length, 0);
  });

  test('negado: denunciar duas vezes o mesmo post (409)', async () => {
    addMember(5);
    const first = await report(5);
    const second = await report(5, { reason: 'ofensa' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
    assert.equal(second.body.already_reported, true);
    assert.equal(db.reports.length, 1);
    assert.ok(db.queries.some((q) => q.text === 'ROLLBACK'));
  });

  test('negado: o autor não denuncia o próprio post', async () => {
    addMember(AUTHOR);
    const res = await report(AUTHOR);
    assert.equal(res.status, 400);
    assert.equal(db.reports.length, 0);
  });

  test('negado: post de outra comunidade pelo slug errado (404)', async () => {
    addMember(5);
    const res = await report(5, { postId: 11 });
    assert.equal(res.status, 404);
    assert.equal(db.reports.length, 0);
  });

  test('post ou id inexistente: 404', async () => {
    addMember(5);
    assert.equal((await report(5, { postId: 999 })).status, 404);
    assert.equal((await report(5, { postId: 'abc' })).status, 404);
    assert.equal((await report(5, { postId: '99999999999' })).status, 404);
    assert.equal(db.reports.length, 0);
  });

  test('motivo fora da lista: 400', async () => {
    addMember(5);
    for (const reason of ['nao-existe', '', null, 5]) {
      const res = await report(5, { reason });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /motivos da lista/);
    }
    assert.equal(db.reports.length, 0);
  });

  test('comentário: mais de 280 caracteres ou não texto é recusado; vazio vira null', async () => {
    addMember(5);
    addMember(7);
    const long = await report(5, { details: 'a'.repeat(281) });
    const notText = await report(5, { details: { a: 1 } });
    assert.equal(long.status, 400);
    assert.match(long.body.error, /280 caracteres/);
    assert.equal(notText.status, 400);
    const empty = await report(7, { details: '   ' });
    assert.equal(empty.status, 201);
    assert.equal(db.reports[0].details, null);
  });

  test('crise no comentário: denúncia vale, comentário não é gravado nem logado', async () => {
    addMember(5);
    const res = await report(5, { reason: 'perigoso', details: 'hoje eu quero me matar' });
    assert.equal(res.status, 201);
    assert.equal(res.body.reported, true);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.match(res.body.message, /sem o texto que você escreveu/);
    assert.equal(db.reports.length, 1);
    assert.equal(db.reports[0].details, null);
    assert.equal(textReachedDb('matar'), false);
    assert.equal(consoleCalls.length, 0);
  });

  test('crise num comentário longo demais: mostra a ajuda e a denúncia vale', async () => {
    addMember(5);
    const res = await report(5, { details: `quero me matar ${'a'.repeat(400)}` });
    assert.equal(res.status, 201);
    assert.equal(res.body.crisis, true);
    assert.equal(db.reports[0].details, null);
  });

  test('crise com denúncia recusada (não membro): 200 com a ajuda e nada gravado', async () => {
    const res = await report(6, { details: 'sinto que sou um peso' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reported, false);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'medio');
    assert.equal(db.reports.length, 0);
    assert.equal(textReachedDb('peso'), false);
  });

  test('o post é travado antes de gravar e contar', async () => {
    addMember(5);
    await report(5);
    const texts = db.queries.map((q) => q.text);
    const lock = texts.findIndex((t) => /FOR UPDATE/.test(t));
    const insert = texts.findIndex((t) => /^INSERT INTO community_post_reports/.test(t));
    const count = texts.findIndex((t) => /GROUP BY reason/.test(t));
    assert.ok(lock >= 0 && lock < insert && insert < count);
  });

  test('migração 005 não aplicada: 503 calmo, sem log', async () => {
    addMember(5);
    db.missingSchema = true;
    const res = await report(5);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /ainda não está disponível/);
    assert.equal(consoleCalls.length, 0);
  });

  // ---------- esconder ----------

  test('2 denúncias não escondem; a 3.ª pessoa esconde com o motivo mais citado', async () => {
    for (const id of [5, 6, 7]) addMember(id);
    await report(5, { reason: 'ofensa' });
    await report(6, { reason: 'spam' });
    assert.equal(db.posts[0].hidden_at, null);
    await report(7, { reason: 'ofensa' });
    assert.notEqual(db.posts[0].hidden_at, null);
    assert.equal(db.posts[0].hidden_reason, 'ofensa');
    assert.ok(db.posts.some((p) => p.id === 10), 'escondido não é apagado');
  });

  test('esconder não acontece duas vezes; a 4.ª denúncia só fica registrada', async () => {
    for (const id of [5, 6, 7, 8]) addMember(id);
    for (const id of [5, 6, 7]) await report(id);
    const hiddenAt = db.posts[0].hidden_at;
    const res = await report(8, { reason: 'perigoso' });
    assert.equal(res.status, 201);
    assert.equal(db.posts[0].hidden_at, hiddenAt);
    assert.equal(db.posts[0].hidden_reason, 'spam');
    assert.equal(db.reports.length, 4);
  });

  test('feed: escondido some para os outros e o autor vê com o motivo', async () => {
    for (const id of [AUTHOR, 5, 6, 7]) addMember(id);
    for (const id of [5, 6, 7]) await report(id, { reason: 'perigoso' });

    const other = await request('GET', '/api/communities/foco', { token: tokenFor(5) });
    assert.equal(other.status, 200);
    assert.equal(other.body.posts.length, 0);

    const author = await request('GET', '/api/communities/foco', { token: tokenFor(AUTHOR) });
    assert.equal(author.body.posts.length, 1);
    const post = author.body.posts[0];
    assert.equal(post.hidden, true);
    assert.equal(post.hidden_reason, 'perigoso');
    assert.equal(post.hidden_reason_label, 'Conselho perigoso para a saúde');
    assert.match(post.hidden_message, /escondido/);
    assert.match(post.hidden_message, /não foi apagado/);

    const feedQuery = db.queries.find((q) => /FROM community_posts cp JOIN users u/.test(q.text));
    assert.match(feedQuery.text, /to_jsonb\(cp\) ->> 'hidden_at'/);
    assert.deepEqual(feedQuery.params, [3, 5]);
  });

  test('feed: post visível não leva campos de moderação de outra pessoa', async () => {
    addMember(5);
    const res = await request('GET', '/api/communities/foco', { token: tokenFor(5) });
    assert.equal(res.body.posts.length, 1);
    assert.equal(res.body.posts[0].hidden, false);
    assert.equal('hidden_reason' in res.body.posts[0], false);
    assert.equal('restored_at' in res.body.posts[0], false);
  });

  // ---------- admin ----------

  test('negado: quem não é admin não lista, não restaura e não apaga (403)', async () => {
    db.posts[0].hidden_at = 5;
    const t = tokenFor(AUTHOR);
    const list = await request('GET', '/api/communities/admin/hidden-posts', { token: t });
    const restore = await request('POST', '/api/communities/admin/posts/10/restore', { token: t });
    const del = await request('DELETE', '/api/communities/admin/posts/10', { token: t });
    for (const res of [list, restore, del]) {
      assert.equal(res.status, 403);
      assert.match(res.body.error, /apenas para o admin/);
    }
    assert.equal(db.posts.length, 2);
    assert.equal(db.posts[0].hidden_at, 5);
  });

  test('negado: sem login nas rotas de admin (401)', async () => {
    const list = await request('GET', '/api/communities/admin/hidden-posts');
    const restore = await request('POST', '/api/communities/admin/posts/10/restore');
    const del = await request('DELETE', '/api/communities/admin/posts/10');
    for (const res of [list, restore, del]) assert.equal(res.status, 401);
    assert.equal(db.posts.length, 2);
  });

  test('admin lista os escondidos com motivo e comentários, sem quem denunciou', async () => {
    for (const id of [5, 6, 7]) addMember(id);
    await report(5, { reason: 'spam', details: 'link de loja' });
    await report(6, { reason: 'spam' });
    await report(7, { reason: 'outro' });
    const res = await request('GET', '/api/communities/admin/hidden-posts', { token: tokenFor(ADMIN) });
    assert.equal(res.status, 200);
    assert.equal(res.body.posts.length, 1);
    const post = res.body.posts[0];
    assert.equal(post.hidden_reason, 'spam');
    assert.equal(post.hidden_reason_label, 'Propaganda ou spam');
    assert.equal(post.reports.length, 3);
    assert.equal(post.reports[0].details, 'link de loja');
    assert.equal(JSON.stringify(res.body).includes('reporter_id'), false);
    const listQuery = db.queries.find((q) => /WHERE cp\.hidden_at IS NOT NULL/.test(q.text));
    // reporter_id só é usado dentro do alerta (EXISTS), nunca vai para a resposta.
    const built = /json_build_object\(([^)]*)\)/.exec(listQuery.text)[1];
    assert.doesNotMatch(built, /reporter/);
    assert.doesNotMatch(listQuery.text.split(' FROM community_posts cp ')[0].replace(/EXISTS \(.*?\) AS (urgent|repeat_reporter_alert)/g, ''), /reporter_id/);
  });

  test('admin restaura: volta a aparecer e só denúncias novas contam', async () => {
    for (const id of [5, 6, 7, 8, 9]) addMember(id);
    for (const id of [5, 6, 7]) await report(id);
    const res = await request('POST', '/api/communities/admin/posts/10/restore', { token: tokenFor(ADMIN) });
    assert.equal(res.status, 200);
    assert.equal(res.body.restored, true);
    assert.equal(db.posts[0].hidden_at, null);
    assert.notEqual(db.posts[0].restored_at, null);

    // As 3 antigas não contam mais: 2 novas não escondem.
    await report(8);
    await report(9);
    assert.equal(db.posts[0].hidden_at, null);
    // E quem já denunciou não denuncia de novo.
    assert.equal((await report(5)).status, 409);
  });

  test('admin restaura post que não está escondido (409) ou que não existe (404)', async () => {
    const t = tokenFor(ADMIN);
    const notHidden = await request('POST', '/api/communities/admin/posts/10/restore', { token: t });
    const missingPost = await request('POST', '/api/communities/admin/posts/999/restore', { token: t });
    const badId = await request('POST', '/api/communities/admin/posts/x/restore', { token: t });
    assert.equal(notHidden.status, 409);
    assert.equal(missingPost.status, 404);
    assert.equal(badId.status, 404);
  });

  test('admin apaga de vez: o post e as denúncias saem; de novo dá 404', async () => {
    addMember(5);
    await report(5);
    const t = tokenFor(ADMIN);
    const del = await request('DELETE', '/api/communities/admin/posts/10', { token: t });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    assert.equal(db.posts.some((p) => p.id === 10), false);
    assert.equal(db.reports.length, 0);
    const again = await request('DELETE', '/api/communities/admin/posts/10', { token: t });
    assert.equal(again.status, 404);
  });

  test('admin sem a migração 005: 503 calmo na lista e na restauração', async () => {
    db.missingSchema = true;
    const t = tokenFor(ADMIN);
    const list = await request('GET', '/api/communities/admin/hidden-posts', { token: t });
    const restore = await request('POST', '/api/communities/admin/posts/10/restore', { token: t });
    assert.equal(list.status, 503);
    assert.equal(restore.status, 503);
  });

  // ---------- 18+ e motivo "perigoso" ----------

  test('negado: sem 18+ confirmado não denuncia (403 com código) e nada é gravado', async () => {
    addMember(5);
    db.notAdult.add(5);
    const res = await report(5);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'adult_confirmation_required');
    assert.equal(res.body.adult_confirmation_required, true);
    assert.match(res.body.error, /maiores de 18 anos/);
    assert.equal(db.reports.length, 0);
  });

  test('sem 18+ e com crise no comentário: mostra a ajuda, nada gravado', async () => {
    addMember(5);
    db.notAdult.add(5);
    const res = await report(5, { details: 'quero me matar' });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.saved, false);
    assert.equal(res.body.code, 'adult_confirmation_required');
    assert.equal(db.reports.length, 0);
  });

  test('a conferência de 18+ lê a coluna por to_jsonb (sem a 006, ninguém passa)', async () => {
    addMember(5);
    await report(5);
    const q = db.queries.find((item) => /adult_confirmed FROM users WHERE id = \$1$/.test(item.text));
    assert.ok(q);
    assert.match(q.text, /to_jsonb\(users\) ->> 'adult_confirmed_at'/);
    assert.deepEqual(q.params, [5]);
  });

  test('"perigoso" esconde já na 1.ª denúncia, com esse motivo', async () => {
    addMember(5);
    const res = await report(5, { reason: 'perigoso' });
    assert.equal(res.status, 201);
    const post = db.posts.find((p) => p.id === 10);
    assert.notEqual(post.hidden_at, null);
    assert.equal(post.hidden_reason, 'perigoso');
  });

  test('"perigoso" depois de 1 spam: esconde e o motivo é perigoso', async () => {
    addMember(5);
    addMember(6);
    await report(5, { reason: 'spam' });
    assert.equal(db.posts.find((p) => p.id === 10).hidden_at, null);
    await report(6, { reason: 'perigoso' });
    const post = db.posts.find((p) => p.id === 10);
    assert.notEqual(post.hidden_at, null);
    assert.equal(post.hidden_reason, 'perigoso');
  });

  test('os outros motivos continuam com 3: 2 ofensas não escondem', async () => {
    addMember(5);
    addMember(6);
    await report(5, { reason: 'ofensa' });
    await report(6, { reason: 'improprio' });
    assert.equal(db.posts.find((p) => p.id === 10).hidden_at, null);
  });

  test('admin: "perigoso" vem primeiro com prioridade alta, sem quem denunciou', async () => {
    for (const id of [5, 6, 7, 8]) addMember(id);
    db.posts.push({ id: 12, community_id: 3, user_id: AUTHOR, content: 'Outra dica do autor', created_at: '2026-11-21T11:00:00Z', hidden_at: null, hidden_reason: null, restored_at: null });
    // Post 10 escondido antes, por spam (3 pessoas).
    for (const id of [5, 6, 7]) await report(id, { postId: 10, reason: 'spam' });
    // Post 12 escondido depois, por 1 "perigoso".
    await report(8, { postId: 12, reason: 'perigoso' });
    const res = await request('GET', '/api/communities/admin/hidden-posts', { token: tokenFor(ADMIN) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.posts.map((p) => [p.id, p.priority]), [[12, 'alta'], [10, 'normal']]);
    assert.equal('urgent' in res.body.posts[0], false);
    assert.equal(JSON.stringify(res.body).includes('reporter_id'), false);
    const listQuery = db.queries.find((q) => /WHERE cp\.hidden_at IS NOT NULL/.test(q.text));
    assert.deepEqual(listQuery.params, ['perigoso', 2]);
    assert.match(listQuery.text, /ORDER BY urgent DESC, cp\.hidden_at ASC/);
  });

  test('restaurado e denunciado de novo como "perigoso": esconde outra vez', async () => {
    addMember(5);
    addMember(6);
    await report(5, { reason: 'perigoso' });
    await request('POST', '/api/communities/admin/posts/10/restore', { token: tokenFor(ADMIN) });
    assert.equal(db.posts.find((p) => p.id === 10).hidden_at, null);
    await report(6, { reason: 'perigoso' });
    assert.notEqual(db.posts.find((p) => p.id === 10).hidden_at, null);
  });

  // ---------- salvaguardas do "perigoso" ----------

  function addPosts(...ids) {
    for (const id of ids) {
      db.posts.push({ id, community_id: 3, user_id: AUTHOR, content: `post ${id}`, created_at: '2026-11-21T12:00:00Z', hidden_at: null, hidden_reason: null, restored_at: null });
    }
  }
  const hiddenNow = (id) => db.posts.find((p) => p.id === id).hidden_at != null;

  test('cota: 3 "perigoso" por pessoa em 24 h escondem; a 4.ª não esconde sozinha', async () => {
    addMember(5);
    addPosts(20, 21, 22, 23);
    for (const id of [20, 21, 22]) {
      assert.equal((await report(5, { postId: id, reason: 'perigoso' })).status, 201);
      assert.equal(hiddenNow(id), true, `post ${id}`);
    }
    const fourth = await report(5, { postId: 23, reason: 'perigoso' });
    assert.equal(fourth.status, 201, 'a denúncia é aceita do mesmo jeito');
    assert.equal(fourth.body.message, 'Obrigado. Sua denúncia foi registrada.');
    assert.equal(hiddenNow(23), false);
    const r = db.reports.find((x) => x.post_id === 23);
    assert.equal(r.reason, 'perigoso', 'o motivo escolhido fica guardado');
    assert.equal(r.fast_track, false);
  });

  test('cota: a 4.ª "perigoso" conta como comum e entra nas 3 pessoas', async () => {
    for (const id of [5, 6, 7]) addMember(id);
    addPosts(20, 21, 22, 23);
    for (const id of [20, 21, 22]) await report(5, { postId: id, reason: 'perigoso' });
    await report(5, { postId: 23, reason: 'perigoso' });
    await report(6, { postId: 23, reason: 'spam' });
    assert.equal(hiddenNow(23), false);
    await report(7, { postId: 23, reason: 'spam' });
    assert.equal(hiddenNow(23), true);
    assert.equal(db.posts.find((p) => p.id === 23).hidden_reason, 'spam');
  });

  test('cota: "perigoso" de mais de 24 h atrás não conta', async () => {
    addMember(5);
    addPosts(20);
    for (const id of [91, 92, 93]) {
      db.reports.push({ post_id: id, reporter_id: 5, reason: 'perigoso', details: null, fast_track: true, hid_post_at: null, created_at: 1, old: true });
    }
    await report(5, { postId: 20, reason: 'perigoso' });
    assert.equal(hiddenNow(20), true);
  });

  test('cota: trava a pessoa, depois o post, e só então conta a cota e grava', async () => {
    addMember(5);
    await report(5, { reason: 'perigoso' });
    const texts = db.queries.map((q) => q.text);
    const lockUser = texts.findIndex((t) => /FROM users WHERE id = \$1 FOR UPDATE/.test(t));
    const lockPost = texts.findIndex((t) => /FROM community_posts WHERE id = \$1 AND community_id = \$2 FOR UPDATE/.test(t));
    const quota = texts.findIndex((t) => /fast_track = true AND created_at > NOW\(\) - INTERVAL '24 hours'/.test(t));
    const insert = texts.findIndex((t) => /^INSERT INTO community_post_reports/.test(t));
    assert.ok(lockUser >= 0 && lockUser < lockPost && lockPost < quota && quota < insert);
  });

  test('cota: outros motivos nem consultam a cota', async () => {
    addMember(5);
    await report(5, { reason: 'ofensa' });
    assert.equal(db.queries.some((q) => /fast_track = true AND created_at/.test(q.text)), false);
    assert.equal(db.reports[0].fast_track, false);
  });

  test('alerta do admin: quem escondeu 2 posts em 24 h marca os dois, sem dizer quem', async () => {
    for (const id of [5, 6, 7, 8]) addMember(id);
    addPosts(20, 21, 22);
    await report(5, { postId: 20, reason: 'perigoso' });
    await report(5, { postId: 21, reason: 'perigoso' });
    // Post 22 escondido por 3 outras pessoas, nenhuma repetida.
    for (const id of [6, 7, 8]) await report(id, { postId: 22, reason: 'spam' });

    const res = await request('GET', '/api/communities/admin/hidden-posts', { token: tokenFor(ADMIN) });
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.body.posts.map((p) => [p.id, p.repeat_reporter_alert]));
    assert.deepEqual(byId, { 20: true, 21: true, 22: false });
    assert.equal(JSON.stringify(res.body).includes('reporter_id'), false);
    // Nenhum campo com id ou nome de quem denunciou: só motivo, comentário e hora.
    for (const post of res.body.posts) {
      for (const r of post.reports) assert.deepEqual(Object.keys(r).sort(), ['created_at', 'details', 'reason']);
    }
  });

  test('alerta do admin: 1 post escondido por pessoa não acende', async () => {
    addMember(5);
    addPosts(20);
    await report(5, { postId: 20, reason: 'perigoso' });
    const res = await request('GET', '/api/communities/admin/hidden-posts', { token: tokenFor(ADMIN) });
    assert.equal(res.body.posts[0].repeat_reporter_alert, false);
  });

  test('alerta do admin: posts escondidos há mais de 24 h não contam', async () => {
    addMember(5);
    addPosts(20);
    db.reports.push({ post_id: 99, reporter_id: 5, reason: 'perigoso', details: null, fast_track: true, hid_post_at: 1, created_at: 1, old: true, oldHide: true });
    await report(5, { postId: 20, reason: 'perigoso' });
    const res = await request('GET', '/api/communities/admin/hidden-posts', { token: tokenFor(ADMIN) });
    assert.equal(res.body.posts.find((p) => p.id === 20).repeat_reporter_alert, false);
  });

  test('rotas de admin vêm antes de /:slug', () => {
    const paths = communitiesRouter.stack
      .filter((layer) => layer.route && layer.route.methods.get)
      .map((layer) => layer.route.path);
    assert.ok(paths.indexOf('/admin/hidden-posts') < paths.indexOf('/:slug'));
  });
});
