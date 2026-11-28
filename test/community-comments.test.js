// Comentários nos posts da comunidade (item 4 do beta).
// Banco simulado: nada de banco real, nenhum dado pessoal, nenhum segredo.
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');
const { ownOrDuoMissionSql } = require('../lib/mission-participation');
const RULE_TEXT = String(ownOrDuoMissionSql('$1', 'm')).replace(/\s+/g, ' ').trim();

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const communitiesRouter = require('../routes/communities');

const app = express();
app.use(express.json());
app.use('/api/communities', communitiesRouter);

const AUTOR = 2;
const LEITOR = 3;
const OUTRO = 4;
const POST_ID = 10;
const COMENTARIO_ID = 100;

const db = {};

function resetDb() {
  db.communities = [
    { id: 3, slug: 'foco', name: 'Foco', area: 'mente' },
    { id: 4, slug: 'alimentacao', name: 'Alimentação', area: 'corpo' }
  ];
  db.members = [];
  db.areas = new Map([[LEITOR, ['mente']], [OUTRO, ['mente']]]);
  db.posts = [
    { id: POST_ID, community_id: 3, user_id: AUTOR, hidden_at: null },
    { id: 11, community_id: 4, user_id: AUTOR, hidden_at: null }
  ];
  db.comments = [{
    id: COMENTARIO_ID,
    post_id: POST_ID,
    user_id: AUTOR,
    content: 'Um comentário do autor',
    created_at: 1000,
    hidden_at: null,
    hidden_reason: null,
    restored_at: null
  }];
  db.reports = [];
  db.supports = [];
  db.recent = new Map();
  db.queries = [];
  db.clock = 2000;
  db.notAdult = new Set();
  db.missingSchema = false;
  db.failInsert = false;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function missing() {
  const err = new Error('relação não existe');
  err.code = '42P01';
  return err;
}

function maybeMissing(text) {
  if (db.missingSchema && /community_comment/.test(text)) throw missing();
}

function handle(sql, params = []) {
  const text = normalize(sql);
  db.queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };

  if (/adult_confirmed_at'\) IS NOT NULL AS adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !db.notAdult.has(Number(params[0])) }] };
  }

  if (/^SELECT m\.area FROM missions m WHERE/.test(text) && /AND m\.status = 'active'$/.test(text)) {
    return { rows: (db.areas.get(Number(params[0])) || []).map((area) => ({ area })) };
  }

  if (/^SELECT \* FROM communities WHERE slug = \$1/i.test(text)
      || /^SELECT id, slug FROM communities WHERE slug = \$1/i.test(text)) {
    const c = db.communities.find((item) => item.slug === params[0]);
    return { rows: c ? [{ ...c }] : [] };
  }

  if (/FROM community_members WHERE community_id = \$1 AND user_id = \$2/i.test(text)) {
    const m = db.members.find((item) =>
      item.community_id === Number(params[0]) && item.user_id === Number(params[1]));
    return { rows: m ? [{ ...m }] : [] };
  }

  // Post alvo dos comentários.
  if (/^SELECT cp\.id, cp\.user_id, \(to_jsonb\(cp\) ->> 'hidden_at'\) IS NOT NULL AS hidden FROM community_posts cp WHERE cp\.id = \$1 AND cp\.community_id = \$2/i.test(text)) {
    const p = db.posts.find((item) => item.id === Number(params[0]) && item.community_id === Number(params[1]));
    return { rows: p ? [{ ...p }] : [] };
  }

  if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/i.test(text)) {
    return { rows: [{ id: Number(params[0]) }] };
  }

  // Cota de comentários em 24 horas.
  if (/^SELECT COUNT\(\*\) AS total FROM community_comments WHERE user_id = \$1/i.test(text)) {
    maybeMissing(text);
    const total = (db.recent.get(Number(params[0])) || 0)
      + db.comments.filter((c) => c.user_id === Number(params[0])).length;
    return { rows: [{ total: String(total) }] };
  }

  if (/^INSERT INTO community_comments/i.test(text)) {
    maybeMissing(text);
    if (db.failInsert) throw new Error('falha simulada do banco');
    const row = {
      id: db.comments.length + 1,
      post_id: Number(params[0]),
      user_id: Number(params[1]),
      content: params[2],
      created_at: ++db.clock,
      hidden_at: null,
      hidden_reason: null,
      restored_at: null
    };
    db.comments.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }

  // Lista de comentários do post.
  if (/FROM community_comments cc JOIN users u ON cc\.user_id = u\.id/i.test(text)) {
    maybeMissing(text);
    const rows = db.comments
      .filter((c) => c.post_id === Number(params[0]))
      .filter((c) => !c.hidden_at || c.user_id === Number(params[1]))
      .sort((a, b) => a.created_at - b.created_at)
      .map((c) => ({
        ...c,
        username: `pessoa${c.user_id}`,
        hidden: c.hidden_at != null,
        hidden_reason: c.user_id === Number(params[1]) ? c.hidden_reason : null,
        supports: db.supports.filter((s) => s.comment_id === c.id).length,
        supported_by_me: db.supports.some((s) => s.comment_id === c.id && s.user_id === Number(params[1]))
      }));
    return { rows };
  }

  // Comentário travado para denúncia.
  if (/^SELECT cc\.id, cc\.user_id, cc\.hidden_at, cc\.restored_at/i.test(text) && /FOR UPDATE$/i.test(text)) {
    maybeMissing(text);
    const c = db.comments.find((item) => item.id === Number(params[0])
      && item.post_id === Number(params[1]));
    return { rows: c ? [{ id: c.id, user_id: c.user_id, hidden_at: c.hidden_at, restored_at: c.restored_at }] : [] };
  }

  // Cota de "perigoso" da pessoa.
  if (/FROM community_comment_reports WHERE reporter_id = \$1 AND fast_track = true/i.test(text)) {
    maybeMissing(text);
    const total = db.reports.filter((r) => r.reporter_id === Number(params[0]) && r.fast_track && !r.old).length;
    return { rows: [{ total: String(total) }] };
  }

  if (/^INSERT INTO community_comment_reports/i.test(text)) {
    maybeMissing(text);
    const [commentId, reporterId, reason, details, fastTrack] = params;
    if (db.reports.some((r) => r.comment_id === commentId && r.reporter_id === reporterId)) {
      return { rows: [], rowCount: 0 };
    }
    const row = {
      comment_id: commentId,
      reporter_id: reporterId,
      reason,
      details,
      fast_track: fastTrack,
      hid_comment_at: null,
      created_at: ++db.clock
    };
    db.reports.push(row);
    return { rows: [{ id: db.reports.length }], rowCount: 1 };
  }

  if (/FROM community_comment_reports WHERE comment_id = \$1 AND/i.test(text) && /GROUP BY reason, fast_track/i.test(text)) {
    maybeMissing(text);
    const since = params[1];
    const counts = new Map();
    for (const r of db.reports) {
      if (r.comment_id !== Number(params[0])) continue;
      if (since != null && !(r.created_at > since)) continue;
      const key = `${r.reason}|${r.fast_track}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rows = [...counts].map(([key, total]) => {
      const [reason, fastTrack] = key.split('|');
      return { reason, fast_track: fastTrack === 'true', total: String(total) };
    });
    return { rows };
  }

  if (/^UPDATE community_comments SET hidden_at = NOW\(\)/i.test(text)) {
    maybeMissing(text);
    const c = db.comments.find((item) => item.id === Number(params[0]));
    if (c && !c.hidden_at) {
      c.hidden_at = ++db.clock;
      c.hidden_reason = params[1];
    }
    return { rows: [], rowCount: c ? 1 : 0 };
  }

  if (/^UPDATE community_comment_reports SET hid_comment_at = NOW\(\)/i.test(text)) {
    maybeMissing(text);
    let n = 0;
    for (const r of db.reports) {
      if (r.comment_id !== Number(params[0])) continue;
      if (params[1] != null && !(r.created_at > params[1])) continue;
      r.hid_comment_at = ++db.clock;
      n += 1;
    }
    return { rows: [], rowCount: n };
  }

  // Comentário que pode receber apoio.
  if (/^SELECT cc\.id, cc\.user_id, \(to_jsonb\(cc\) ->> 'hidden_at'\) IS NOT NULL AS hidden FROM community_comments cc JOIN community_posts cp/i.test(text)) {
    maybeMissing(text);
    const c = db.comments.find((item) => item.id === Number(params[0])
      && item.post_id === Number(params[1]));
    if (!c || c.hidden_at) return { rows: [] };
    return { rows: [{ id: c.id, user_id: c.user_id, hidden: false }] };
  }

  if (/^INSERT INTO community_comment_supports/i.test(text)) {
    maybeMissing(text);
    const [commentId, userId] = params;
    if (db.supports.some((s) => s.comment_id === commentId && s.user_id === userId)) {
      return { rows: [], rowCount: 0 };
    }
    db.supports.push({ comment_id: commentId, user_id: userId });
    return { rows: [{ id: db.supports.length }], rowCount: 1 };
  }

  if (/^DELETE FROM community_comment_supports/i.test(text)) {
    maybeMissing(text);
    const before = db.supports.length;
    db.supports = db.supports.filter((s) => !(s.comment_id === Number(params[0]) && s.user_id === Number(params[1])));
    return { rows: [], rowCount: before - db.supports.length };
  }

  if (/^SELECT COUNT\(\*\)::int AS total FROM community_comment_supports/i.test(text)) {
    maybeMissing(text);
    return { rows: [{ total: db.supports.filter((s) => s.comment_id === Number(params[0])).length }] };
  }

  return { rows: [] };
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

function addMember(userId, slug = 'foco') {
  const community = db.communities.find((c) => c.slug === slug);
  db.members.push({ community_id: community.id, user_id: userId });
  db.areas.set(userId, [community.area]);
}

function insertedComment() {
  return db.queries.some((q) => /^INSERT INTO community_comments/i.test(q.text));
}

function insertedReport() {
  return db.queries.some((q) => /^INSERT INTO community_comment_reports/i.test(q.text));
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

const caminho = `/api/communities/foco/posts/${POST_ID}/comments`;

describe('comentários nos posts da comunidade', { concurrency: 1 }, () => {
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

  // ---------- Migração ----------

  test('a migração 018 só acrescenta, com chaves únicas e registro de versão', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '018_community_comments.sql'), 'utf8');
    const corpo = sql.split('\n').filter((linha) => !linha.trimStart().startsWith('--')).join('\n');
    assert.match(corpo, /BEGIN;/);
    assert.match(corpo, /COMMIT;/);
    assert.match(corpo, /CREATE TABLE IF NOT EXISTS community_comments/);
    assert.match(corpo, /CREATE TABLE IF NOT EXISTS community_comment_reports/);
    assert.match(corpo, /CREATE TABLE IF NOT EXISTS community_comment_supports/);
    assert.match(corpo, /UNIQUE \(comment_id, reporter_id\)/);
    assert.match(corpo, /UNIQUE \(comment_id, user_id\)/);
    assert.match(corpo, /char_length\(content\) BETWEEN 1 AND 280/);
    assert.match(corpo, /ON DELETE CASCADE/);
    assert.match(corpo, /VALUES \('018_community_comments'\)/);
    assert.doesNotMatch(corpo, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(corpo, /\bUPDATE\s+\w+/i);
    assert.doesNotMatch(corpo, /\bDELETE\s+FROM\b/i);
  });

  // ---------- Escrever ----------

  test('comentário válido: 201, sem user_id, com is_mine e transação travada', async () => {
    addMember(LEITOR);
    const res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content: 'Ótima dica, obrigado.' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.comment.is_mine, true);
    assert.equal(res.body.comment.user_id, undefined);
    assert.equal(res.body.comment.hidden, false);
    assert.equal(res.body.comment.supports, 0);
    assert.ok(db.queries.some((q) => /FROM users WHERE id = \$1 FOR UPDATE/.test(q.text)));
    assert.ok(db.queries.some((q) => /^COMMIT$/.test(q.text)));
  });

  test('crise antes de gravar: ajuda, nada no banco, nada no log', async () => {
    addMember(LEITOR);
    const res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content: 'hoje eu quero me matar' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.commented, false);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(insertedComment(), false);
    assert.equal(textReachedDb('matar'), false);
    assert.equal(consoleCalls.length, 0);
  });

  test('crise vale também sem 18+ e sem ser membro', async () => {
    db.notAdult.add(LEITOR);
    const res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content: 'quero me matar' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
    assert.equal(insertedComment(), false);
  });

  test('texto vazio, longo demais ou não texto: 400 e nada gravado', async () => {
    addMember(LEITOR);
    for (const content of ['', '   ', 'a'.repeat(281), 42]) {
      const res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content } });
      assert.equal(res.status, 400);
    }
    assert.equal(insertedComment(), false);
  });

  test('limite de 10 comentários em 24 horas, com rollback e sem novo insert', async () => {
    addMember(LEITOR);
    db.recent.set(LEITOR, 10);
    const res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content: 'Mais um comentário.' } });
    assert.equal(res.status, 429);
    assert.equal(res.body.limit, 10);
    assert.equal(insertedComment(), false);
    assert.ok(db.queries.some((q) => /^ROLLBACK$/.test(q.text)));
  });

  test('não membro, sem 18+, comunidade só de leitura e post de outra comunidade', async () => {
    let res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content: 'Oi.' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not_member');

    addMember(LEITOR);
    db.notAdult.add(LEITOR);
    res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content: 'Oi.' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'adult_confirmation_required');
    db.notAdult.delete(LEITOR);

    res = await request('POST', `/api/communities/alimentacao/posts/11/comments`, {
      token: tokenFor(LEITOR), body: { content: 'Oi.' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'read_only');

    res = await request('POST', `/api/communities/foco/posts/999/comments`, {
      token: tokenFor(LEITOR), body: { content: 'Oi.' }
    });
    assert.equal(res.status, 404);
    assert.equal(insertedComment(), false);
  });

  test('sem migração 018: 503 calmo, sem 500', async () => {
    addMember(LEITOR);
    db.missingSchema = true;
    const res = await request('POST', caminho, { token: tokenFor(LEITOR), body: { content: 'Oi.' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'unavailable');
    assert.equal(insertedComment(), false);
  });

  // ---------- Ler ----------

  test('lista: sem user_id, is_mine, apoios e comentário escondido some para os outros', async () => {
    db.comments[0].hidden_at = 1500;
    db.comments[0].hidden_reason = 'ofensa';
    const res = await request('GET', caminho, { token: tokenFor(LEITOR) });
    assert.equal(res.status, 200);
    assert.equal(res.body.comments.length, 0);

    const dono = await request('GET', caminho, { token: tokenFor(AUTOR) });
    assert.equal(dono.status, 200);
    assert.equal(dono.body.comments.length, 1);
    assert.equal(dono.body.comments[0].user_id, undefined);
    assert.equal(dono.body.comments[0].is_mine, true);
    assert.equal(dono.body.comments[0].hidden, true);
    assert.match(dono.body.comments[0].hidden_message, /não foi apagado/);
    assert.equal(dono.body.comments[0].supports, 0);
    assert.equal(dono.body.comments[0].supported_by_me, false);
  });

  // ---------- Denúncia ----------

  test('denúncia: próprio comentário, motivo inválido e duplicata são recusados', async () => {
    addMember(LEITOR);
    addMember(AUTOR);
    const base = `${caminho}/${COMENTARIO_ID}/report`;
    let res = await request('POST', base, { token: tokenFor(AUTOR), body: { reason: 'spam' } });
    assert.equal(res.status, 400);

    res = await request('POST', base, { token: tokenFor(LEITOR), body: { reason: 'inventado' } });
    assert.equal(res.status, 400);

    res = await request('POST', base, { token: tokenFor(LEITOR), body: { reason: 'spam' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.reported, true);

    res = await request('POST', base, { token: tokenFor(LEITOR), body: { reason: 'spam' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.already_reported, true);
  });

  test('denúncia com crise no texto: vale, mas o texto não é gravado nem logado', async () => {
    addMember(LEITOR);
    const res = await request('POST', `${caminho}/${COMENTARIO_ID}/report`, {
      token: tokenFor(LEITOR), body: { reason: 'perigoso', details: 'quero me matar' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.reported, true);
    assert.equal(res.body.crisis, true);
    assert.equal(res.body.crisis_level, 'alto');
    assert.equal(insertedReport(), true);
    assert.equal(textReachedDb('matar'), false);
    assert.equal(db.reports[0].details, null);
    assert.equal(consoleCalls.length, 0);
  });

  test('denúncia recusada com crise devolve ajuda, não erro', async () => {
    addMember(LEITOR);
    const res = await request('POST', `${caminho}/${COMENTARIO_ID}/report`, {
      token: tokenFor(LEITOR), body: { reason: 'inventado', details: 'quero me matar' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.reported, false);
    assert.equal(res.body.crisis, true);
    assert.equal(insertedReport(), false);
    assert.equal(textReachedDb('matar'), false);
  });

  test('três pessoas escondem o comentário; o autor vê o motivo', async () => {
    for (const id of [LEITOR, OUTRO, LEITOR + 10]) addMember(id);
    for (const id of [LEITOR, OUTRO, LEITOR + 10]) {
      const res = await request('POST', `${caminho}/${COMENTARIO_ID}/report`, {
        token: tokenFor(id), body: { reason: 'ofensa' }
      });
      assert.equal(res.status, 201);
    }
    assert.ok(db.comments[0].hidden_at);
    assert.equal(db.comments[0].hidden_reason, 'ofensa');
    assert.ok(db.reports.every((r) => r.hid_comment_at != null));

    const dono = await request('GET', caminho, { token: tokenFor(AUTOR) });
    assert.equal(dono.body.comments[0].hidden, true);
    assert.equal(dono.body.comments[0].hidden_reason_label, 'Ofensa ou ataque a alguém');
  });

  test('perigoso esconde na primeira denúncia, até a cota de 3', async () => {
    addMember(LEITOR);
    const res = await request('POST', `${caminho}/${COMENTARIO_ID}/report`, {
      token: tokenFor(LEITOR), body: { reason: 'perigoso' }
    });
    assert.equal(res.status, 201);
    assert.equal(db.reports[0].fast_track, true);
    assert.equal(db.comments[0].hidden_reason, 'perigoso');
  });

  test('sem 18+ na denúncia: ajuda antes de gravar', async () => {
    addMember(LEITOR);
    db.notAdult.add(LEITOR);
    const res = await request('POST', `${caminho}/${COMENTARIO_ID}/report`, {
      token: tokenFor(LEITOR), body: { reason: 'spam' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'adult_confirmation_required');
    assert.equal(insertedReport(), false);
  });

  // ---------- Apoio ----------

  test('apoio: próprio comentário 403, duplicata 409, DELETE idempotente, sem quem apoiou', async () => {
    const alvo = `${caminho}/${COMENTARIO_ID}/support`;
    let res = await request('POST', alvo, { token: tokenFor(AUTOR) });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'own_comment');

    res = await request('POST', alvo, { token: tokenFor(LEITOR) });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ['supported', 'supports']);

    res = await request('POST', alvo, { token: tokenFor(LEITOR) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'already_supported');

    res = await request('POST', alvo, { token: tokenFor(OUTRO) });
    assert.equal(res.status, 201);
    assert.equal(res.body.supports, 2);

    res = await request('DELETE', alvo, { token: tokenFor(LEITOR) });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, true);
    assert.equal(res.body.supports, 1);

    res = await request('DELETE', alvo, { token: tokenFor(LEITOR) });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, false);
    assert.equal(res.body.supports, 1);
  });

  test('apoio em comentário escondido: 404, sem nome de quem apoiou', async () => {
    db.comments[0].hidden_at = 1500;
    const res = await request('POST', `${caminho}/${COMENTARIO_ID}/support`, { token: tokenFor(LEITOR) });
    assert.equal(res.status, 404);
  });
});
