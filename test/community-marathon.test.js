// Maratona da comunidade refeita (PR E, migração 017). Banco simulado; o SQL
// (dia de Lisboa, UNIQUE, trava do limite) foi conferido num Postgres
// descartável. Substitui test/community-missions-access.test.js (rotas
// antigas: ranking individual e "scope" agora respondem 410).
const { describe, test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const { Pool } = require('pg');
const { withAuthDb } = require('./helpers/auth-db');

process.env.JWT_SECRET = 'teste-apenas-local';
process.env.DATABASE_URL = 'postgres://127.0.0.1:5432/nexus_teste';

const marathonRouter = require('../routes/community-missions');
const checkinsRouter = require('../routes/checkins');
const { meritCountSql } = require('../lib/merit');

const app = express();
app.use(express.json());
app.use('/api/community-missions', marathonRouter);
app.use('/api/checkins', checkinsRouter);

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

const st = {};
function reset() {
  st.queries = [];
  st.notAdult = new Set();
  st.members = new Set([1, 2]);          // membros da comunidade "foco"
  st.areas = new Map([[1, ['mente']]]);  // missões ativas por pessoa
  st.marathon = { id: 40, title: 'Ler 7 dias', description: 'Uma página', duration_days: 7, max_participants: 3, day_number: 2, participants: new Set([1]) };
  st.checkins = new Set();               // `${user}`: registro de hoje
  st.before017 = false;
  st.dayAtInsert = null;
  st.openByMe = 0;
  st.personal = { id: 11, user_id: 1, partner_id: null, status: 'active', mode: 'solo', proof_mode: 'self_report', started_at: new Date().toISOString(), duration_days: 30 };
}

function handle(sql, params = []) {
  const text = normalize(sql);
  st.queries.push({ text, params });
  if (/adult_confirmed FROM users WHERE id = \$1$/i.test(text)) {
    return { rows: [{ adult_confirmed: !st.notAdult.has(Number(params[0])) }] };
  }
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
  if (/^SELECT c\.id, c\.slug, c\.name, to_jsonb\(c\) ->> 'area' AS area/.test(text)) {
    if (params[0] !== 'foco') return { rows: [] };
    return { rows: [{ id: 3, slug: 'foco', name: 'Foco', area: 'mente', is_member: st.members.has(Number(params[1])) }] };
  }
  if (/^SELECT m\.area FROM missions m WHERE/.test(text)) {
    return { rows: (st.areas.get(Number(params[0])) || []).map((area) => ({ area })) };
  }
  if (/start_day/.test(text) && st.before017) throw Object.assign(new Error('column "start_day" does not exist'), { code: '42703' });
  if (/^SELECT cm\.id, cm\.title, cm\.description, cm\.duration_days, cm\.max_participants, cm\.start_day/.test(text)) {
    const m = st.marathon;
    if (!m || Number(params[0]) !== m.id || Number(params[1]) !== 3) return { rows: [] };
    return { rows: [{ ...m, start_day: '2026-11-26', is_participant: m.participants.has(Number(params[2])) }] };
  }
  if (/^SELECT COUNT\(\*\)::int AS total FROM community_mission_participants/.test(text)) {
    return { rows: [{ total: st.marathon.participants.size }] };
  }
  if (/^INSERT INTO community_mission_participants/.test(text)) {
    st.marathon.participants.add(Number(params[1]));
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO community_marathon_checkins/.test(text)) {
    if (st.before017) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const key = String(params[1]);
    // dayAtInsert: o relógio virou entre a leitura e o registro.
    if (st.dayAtInsert != null) st.marathon.day_number = st.dayAtInsert;
    const day = Number(st.marathon.day_number);
    if (day < 1 || day > st.marathon.duration_days) return { rows: [], rowCount: 0 };
    if (st.checkins.has(key)) return { rows: [], rowCount: 0 };
    st.checkins.add(key);
    return { rows: [{ day_number: day }], rowCount: 1 };
  }
  if (/^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/.test(text)) return { rows: [{ id: Number(params[0]) }] };
  if (/^SELECT COUNT\(\*\)::int AS total FROM community_missions WHERE community_id = \$1 AND created_by = \$2/.test(text)) {
    return { rows: [{ total: st.openByMe }] };
  }
  if (/^INSERT INTO community_missions/.test(text)) {
    return { rows: [{ id: 41, title: params[1], description: params[2], duration_days: params[3], max_participants: params[4], start_day: '2026-11-27' }], rowCount: 1 };
  }
  // Check-in pessoal (/api/checkins), para provar que não depende do 18+.
  if (/^INSERT INTO checkins/i.test(text)) {
    return { rows: [{ id: 1, mission_id: params[0], user_id: params[1], day_number: params[2], completed: true, note: null }], rowCount: 1 };
  }
  if (/FROM missions\b/i.test(text) && /FOR UPDATE/i.test(text)) return { rows: [{ ...st.personal }] };
  if (/FROM missions m\b/i.test(text)) return { rows: [{ ...st.personal }] };
  return { rows: [] };
}

const tokenFor = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
let server;
let baseUrl;

async function call(method, p, { token = tokenFor(1), body } = {}) {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body == null ? {} : { 'Content-Type': 'application/json' }) },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const raw = await r.text();
  return { status: r.status, body: raw ? JSON.parse(raw) : {} };
}

const wrote = (table) => st.queries.some((q) => new RegExp(`^INSERT INTO ${table}\\b`, 'i').test(q.text));
const GOOD = { title: 'Ler 7 dias', description: 'Uma página por dia', duration_days: 7, max_participants: 20 };

describe('Maratona da comunidade', { concurrency: 1 }, () => {
  before(async () => {
    reset();
    mock.method(Pool.prototype, 'query', withAuthDb(async (sql, params) => handle(sql, params)));
    mock.method(Pool.prototype, 'connect', async () => ({ query: async (sql, params) => handle(sql, params), release() {} }));
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => reset());

  // ---------- Criar ----------

  test('membro com missão ativa da área cria; quem cria entra', async () => {
    const res = await call('POST', '/api/community-missions/foco', { body: GOOD });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Maratona criada.');
    const q = st.queries.find((item) => /^INSERT INTO community_missions/.test(item.text));
    assert.match(q.text, /'maratona'/);
    // date + parâmetro precisa do tipo (no Postgres real, sem ::int dá erro).
    assert.match(q.text, /\(d\.day \+ \$4::int\)::timestamp/);
    assert.match(q.text, /\(NOW\(\) AT TIME ZONE 'Europe\/Lisbon'\)::date/);
    assert.match(q.text, /WHERE d\.day BETWEEN \(NOW\(\) AT TIME ZONE 'Europe\/Lisbon'\)::date AND \(NOW\(\) AT TIME ZONE 'Europe\/Lisbon'\)::date \+ 14/);
    assert.ok(wrote('community_mission_participants'));
  });

  test('negado: já tem uma maratona aberta nesta comunidade: 409, nada criado; a trava vem antes da contagem', async () => {
    st.openByMe = 1;
    const res = await call('POST', '/api/community-missions/foco', { body: GOOD });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'open_marathon');
    assert.equal(res.body.error, 'Você já tem uma maratona aberta nesta comunidade. Quando ela terminar, você pode criar outra.');
    assert.equal(wrote('community_missions'), false);
    const texts = st.queries.map((q) => q.text);
    const lock = texts.findIndex((t) => /^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/.test(t));
    const count = texts.findIndex((t) => /FROM community_missions WHERE community_id = \$1 AND created_by = \$2/.test(t));
    assert.ok(lock >= 0 && lock < count);
    assert.match(texts[count], /start_day \+ duration_days - 1 >= \(NOW\(\) AT TIME ZONE 'Europe\/Lisbon'\)::date$/);
    assert.ok(texts.includes('ROLLBACK'));
  });

  test('negado: crise no nome ou no mínimo do dia: ajuda, nada gravado nem enviado ao banco', async () => {
    for (const field of ['title', 'description']) {
      reset();
      const res = await call('POST', '/api/community-missions/foco', { body: { ...GOOD, [field]: 'quero me matar' } });
      assert.equal(res.status, 200, field);
      assert.equal(res.body.crisis, true);
      assert.equal(res.body.saved, false);
      assert.equal(wrote('community_missions'), false);
      assert.equal(st.queries.some((q) => q.params.some((p) => typeof p === 'string' && p.includes('matar'))), false);
    }
  });

  test('negado: sem 18+ e nome de crise: a ajuda vem antes do 403', async () => {
    st.notAdult.add(1);
    const res = await call('POST', '/api/community-missions/foco', { body: { ...GOOD, title: 'quero me matar' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.crisis, true);
  });

  test('negado: quem não é membro não cria; sem missão ativa da área também não', async () => {
    const outsider = await call('POST', '/api/community-missions/foco', { token: tokenFor(9), body: GOOD });
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.code, 'not_member');
    st.areas.set(2, ['corpo']);
    const otherArea = await call('POST', '/api/community-missions/foco', { token: tokenFor(2), body: GOOD });
    assert.equal(otherArea.status, 403);
    assert.equal(otherArea.body.code, 'other_area');
    assert.equal(wrote('community_missions'), false);
  });

  test('negado: textos, dias, pessoas e início fora da regra: 400', async () => {
    const cases = [
      [{ ...GOOD, title: '' }, 'invalid_title'],
      [{ ...GOOD, title: 'a'.repeat(61) }, 'invalid_title'],
      [{ ...GOOD, description: '' }, 'invalid_minimum'],
      [{ ...GOOD, title: { a: 1 } }, 'invalid_text'],
      [{ ...GOOD, duration_days: 2 }, 'invalid_days'],
      [{ ...GOOD, duration_days: 31 }, 'invalid_days'],
      [{ ...GOOD, duration_days: '7' }, 'invalid_days'],
      [{ ...GOOD, max_participants: 1 }, 'invalid_people'],
      [{ ...GOOD, max_participants: 101 }, 'invalid_people'],
      [{ ...GOOD, start_day: 'amanhã' }, 'invalid_start']
    ];
    for (const [body, code] of cases) {
      const res = await call('POST', '/api/community-missions/foco', { body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 50));
      assert.equal(res.body.code, code);
    }
    assert.equal(wrote('community_missions'), false);
  });

  // ---------- Entrar ----------

  test('membro entra; entrar de novo não duplica', async () => {
    const res = await call('POST', '/api/community-missions/foco/40/join', { token: tokenFor(2) });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Você entrou na maratona.');
    const again = await call('POST', '/api/community-missions/foco/40/join', { token: tokenFor(2) });
    assert.equal(again.status, 200);
    assert.equal(again.body.already, true);
    // O limite é conferido com a maratona travada.
    assert.ok(st.queries.some((q) => /FOR UPDATE OF cm$/.test(q.text)));
  });

  test('negado: quem não é membro da comunidade não entra', async () => {
    const res = await call('POST', '/api/community-missions/foco/40/join', { token: tokenFor(9) });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not_member');
    assert.equal(wrote('community_mission_participants'), false);
  });

  test('negado: maratona cheia ou já terminada não aceita mais gente', async () => {
    st.marathon.participants = new Set([1, 5, 6]);
    const full = await call('POST', '/api/community-missions/foco/40/join', { token: tokenFor(2) });
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'full');
    reset();
    st.marathon.day_number = 8;
    const ended = await call('POST', '/api/community-missions/foco/40/join', { token: tokenFor(2) });
    assert.equal(ended.status, 409);
    assert.equal(ended.body.code, 'ended');
    assert.equal(wrote('community_mission_participants'), false);
  });

  // ---------- Registrar o dia ----------

  test('registrar o dia: grava na tabela da Maratona, NUNCA em checkins', async () => {
    const res = await call('POST', '/api/community-missions/foco/40/checkin');
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { done: true, day: 2, message: 'Dia registrado na maratona.' });
    assert.ok(wrote('community_marathon_checkins'));
    assert.equal(wrote('checkins'), false);
    const q = st.queries.find((item) => /^INSERT INTO community_marathon_checkins/.test(item.text));
    // Data e número do dia no MESMO SQL (não divergem na meia-noite de Lisboa).
    assert.match(q.text, /SELECT cm\.id, \$2, t\.today, \(t\.today - cm\.start_day \+ 1\) FROM community_missions cm CROSS JOIN \(SELECT \(NOW\(\) AT TIME ZONE 'Europe\/Lisbon'\)::date AS today\) t/);
    assert.match(q.text, /AND t\.today BETWEEN cm\.start_day AND cm\.start_day \+ cm\.duration_days - 1/);
    assert.match(q.text, /ON CONFLICT \(community_mission_id, user_id, day_date\) DO NOTHING RETURNING day_number$/);
    assert.deepEqual(q.params, [40, 1]);
  });

  test('negado: registrar duas vezes no mesmo dia: 409, nada novo', async () => {
    await call('POST', '/api/community-missions/foco/40/checkin');
    const again = await call('POST', '/api/community-missions/foco/40/checkin');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_done');
    assert.equal(again.body.error, 'Você já registrou o dia de hoje na maratona.');
    assert.equal(st.checkins.size, 1);
  });

  test('negado: fora do período (antes do início ou depois do fim): 409, nada gravado', async () => {
    st.marathon.day_number = 0;
    const early = await call('POST', '/api/community-missions/foco/40/checkin');
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'not_started');
    st.marathon.day_number = 8;
    const late = await call('POST', '/api/community-missions/foco/40/checkin');
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'ended');
    assert.equal(wrote('community_marathon_checkins'), false);
  });

  test('negado: quem não participa não registra; maratona de outra comunidade ou id ruim: 404', async () => {
    const res = await call('POST', '/api/community-missions/foco/40/checkin', { token: tokenFor(2) });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not_participant');
    assert.equal((await call('POST', '/api/community-missions/outra/40/checkin')).status, 404);
    assert.equal((await call('POST', '/api/community-missions/foco/999/checkin')).status, 404);
    assert.equal((await call('POST', '/api/community-missions/foco/abc/checkin')).status, 404);
    assert.equal(wrote('community_marathon_checkins'), false);
  });

  test('negado: quem saiu da comunidade não registra, mesmo constando na maratona', async () => {
    st.members.delete(1);
    const res = await call('POST', '/api/community-missions/foco/40/checkin');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not_member');
    assert.equal(res.body.error, 'Entre na comunidade para registrar o dia na maratona.');
    assert.equal(wrote('community_marathon_checkins'), false);
  });

  test('negado: comunidade só leitura: não registra nem entra', async () => {
    const access = require('../lib/community-access');
    access.READ_ONLY_COMMUNITY_SLUGS.push('foco');
    try {
      const checkin = await call('POST', '/api/community-missions/foco/40/checkin');
      assert.equal(checkin.status, 403);
      assert.equal(checkin.body.code, 'read_only');
      const join = await call('POST', '/api/community-missions/foco/40/join', { token: tokenFor(2) });
      assert.equal(join.status, 403);
      assert.equal(join.body.code, 'read_only');
      assert.equal(wrote('community_marathon_checkins'), false);
      assert.equal(wrote('community_mission_participants'), false);
    } finally {
      access.READ_ONLY_COMMUNITY_SLUGS.splice(access.READ_ONLY_COMMUNITY_SLUGS.indexOf('foco'), 1);
    }
  });

  test('a virada do período entre a leitura e o registro: nada gravado, resposta certa', async () => {
    // A leitura diz dia 7 (o último); quando o registro roda, já é o dia 8.
    st.marathon.day_number = 7;
    st.dayAtInsert = 8;
    const res = await call('POST', '/api/community-missions/foco/40/checkin');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ended');
    assert.equal(st.checkins.size, 0);
  });

  test('antes da 017: 503 calmo (listar, ver, registrar)', async () => {
    st.before017 = true;
    for (const [m, p] of [['GET', '/api/community-missions/foco'], ['GET', '/api/community-missions/foco/40'], ['POST', '/api/community-missions/foco/40/checkin']]) {
      const res = await call(m, p);
      assert.equal(res.status, 503, `${m} ${p}`);
      assert.equal(res.body.code, 'unavailable');
    }
  });

  // ---------- Rotas antigas, acesso e mérito ----------

  test('ranking individual e "scope" antigos: 410, sem consultar nada', async () => {
    for (const p of ['/api/community-missions/foco/40/ranking', '/api/community-missions/foco/scope/mundial']) {
      st.queries = [];
      const res = await call('GET', p);
      assert.equal(res.status, 410, p);
      assert.equal(res.body.code, 'gone');
      assert.ok(st.queries.every((q) => /adult_confirmed|SELECT 1 FROM users|FROM users WHERE id/.test(q.text)), p);
    }
  });

  test('negado: sem login 401; sem 18+ 403 em todas as rotas, nada gravado', async () => {
    // Inclui as rotas antigas (ranking e scope), como no teste removido.
    const calls = [
      ['GET', '/api/community-missions/foco'],
      ['POST', '/api/community-missions/foco', GOOD],
      ['GET', '/api/community-missions/foco/40'],
      ['POST', '/api/community-missions/foco/40/join'],
      ['POST', '/api/community-missions/foco/40/checkin'],
      ['GET', '/api/community-missions/foco/40/ranking'],
      ['GET', '/api/community-missions/foco/scope/mundial']
    ];
    st.queries = [];
    for (const [m, p, body] of calls) {
      assert.equal((await call(m, p, { token: null, body })).status, 401, `${m} ${p}`);
    }
    // Sem login: 401 antes do portão, sem nenhuma consulta ao banco.
    assert.equal(st.queries.length, 0);
    st.notAdult.add(1);
    for (const [m, p, body] of calls) {
      const res = await call(m, p, { body });
      assert.equal(res.status, 403, `${m} ${p}`);
      assert.equal(res.body.code, 'adult_confirmation_required');
    }
    assert.equal(wrote('community_marathon_checkins'), false);
    assert.equal(wrote('community_missions'), false);
    assert.equal(wrote('community_mission_participants'), false);
    assert.equal(wrote('checkins'), false);
    // Com 18+ negado, só a pergunta da idade chegou ao banco.
    assert.ok(st.queries.every((q) => /adult_confirmed FROM users/.test(q.text)));
  });

  test('a Maratona não conta para o título (o mérito só lê missions)', () => {
    assert.doesNotMatch(meritCountSql('u.id'), /community_missions|community_marathon_checkins/);
  });

  test('gancho dos pontos (PR F): existe e não faz nada', async () => {
    assert.equal(typeof marathonRouter.onMarathonDayDone, 'function');
    assert.equal(await marathonRouter.onMarathonDayDone(null, {}), null);
  });

  test('o check-in pessoal (/api/checkins) não depende do 18+ da comunidade', async () => {
    st.notAdult.add(1);
    const solo = await call('POST', '/api/checkins', { body: { mission_id: 11 } });
    assert.equal(solo.status, 201);
  });
});

describe('migração 017', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '017_community_marathon.sql'), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');
  test('só acrescenta; um registro por pessoa, maratona e dia', () => {
    assert.doesNotMatch(code.replace(/ON DELETE CASCADE/g, ''), /\b(DROP|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.match(code, /ADD COLUMN IF NOT EXISTS start_day DATE/);
    assert.match(code, /UNIQUE \(community_mission_id, user_id, day_date\)/);
    assert.match(code, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(code, /'017_community_marathon'/);
    assert.doesNotMatch(code, /ledger|coin|moeda|points/i);
  });
});
