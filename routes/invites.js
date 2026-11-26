// ============================================
// NEXUS — Convite por link para o Duo e o Rival
//
// Decisão de 26/11 (itens 1 e 3; PR 2 do plano do Vitrúvio). Funciona com o
// MATCHING_ENABLED desligado: não chama o pareamento automático.
//
// POST   /api/invites                  { mission_id, kind: "duo"|"rival" }
//        O dono de uma missão Solo ativa cria o convite. A resposta traz o
//        token UMA vez (o site monta o link); o banco guarda só o hash.
//        Um convite novo cancela o anterior ainda aberto da mesma missão.
// DELETE /api/invites/:inviteId        O dono cancela um convite aberto.
// POST   /api/invites/preview          { token } O que o convite é (tela de aceitar).
// POST   /api/invites/accept           { token, mission_id? } Quem abriu o link aceita.
//        O token vai no corpo, nunca na URL (URL entra em registro de acesso).
//        Duo: entra na missão do dono. Rival: liga a própria missão Solo
//        ativa (mission_id) ou, sem ela, cria uma missão nova com o mesmo
//        desafio (título, categoria, nível, mínimo), sem os textos pessoais
//        do dono; as duas viram um par Rival. O início do par é NOW().
//
// Regras: login e 18+ confirmado; não vale o próprio convite, convite usado,
// vencido (7 dias, relógio do banco) ou cancelado; não vale estando já num
// par ativo; não vale entre quem se bloqueou (user_blocks, migração 011).
// Dois aceites ao mesmo tempo: a linha do convite é travada (FOR UPDATE) e
// só o primeiro passa.
// Antes da migração 012: 503 calmo e nada muda. Nada do pedido vai para log.
// ============================================

const crypto = require('crypto');
const express = require('express');
const { db } = require('../lib/db');
const auth = require('../middleware/auth');
const { makeAdultGate, ADULT_REQUIRED_CODE } = require('../lib/adult-gate');

const router = express.Router();
const { hasAdultConfirmation } = makeAdultGate(db);

const INVITE_DAYS = 7;
const KIND_TO_MODE = { duo: 'parceiro', rival: 'rival' };

const MSG = {
  created: `Convite criado. O link vale por ${INVITE_DAYS} dias e só pode ser usado uma vez.`,
  kindInvalid: 'Escolha Duo ou Rival.',
  missionNotFound: 'Missão não encontrada.',
  notSolo: 'Só dá para convidar numa missão Solo ativa.',
  canceled: 'Convite cancelado.',
  alreadyUsed: 'Este convite já foi usado.',
  notFound: 'Convite não encontrado. Confira o link.',
  expired: 'Este convite venceu. Peça um novo a quem convidou.',
  wasCanceled: 'Este convite foi cancelado. Peça um novo a quem convidou.',
  own: 'Você não pode aceitar o seu próprio convite.',
  alreadyPaired: 'Você já está num Duo ou Rival ativo. Saia dele antes de aceitar outro convite.',
  missionTaken: 'Esta missão já não está disponível para convite.',
  blocked: 'Não foi possível aceitar este convite.',
  ownMissionInvalid: 'Escolha uma missão Solo ativa sua.',
  adult: 'O Duo e o Rival são só para maiores de 18 anos.',
  acceptedDuo: 'Pronto. Vocês agora estão em Duo.',
  acceptedRival: 'Pronto. Vocês agora estão em Rival.',
  unavailable: 'O convite ainda não está disponível. Tente de novo mais tarde.',
  error: 'Não deu para concluir agora. Tente de novo daqui a pouco.'
};

function isMissingSchema(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// Token aleatório forte: 32 bytes, base64url (43 caracteres).
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function parseId(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{0,9}$/.test(text)) return null;
  const id = Number(text);
  return id <= 2147483647 ? id : null;
}

// Missão em par ativo: tem parceiro ou está num mission_matches ativo.
const PAIRED_SQL = `(m.partner_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM mission_matches mm
  WHERE mm.status = 'active' AND (mm.mission_a_id = m.id OR mm.mission_b_id = m.id)
))`;

async function adultOr403(userId, res) {
  if (await hasAdultConfirmation(userId)) return true;
  res.status(403).json({ error: MSG.adult, code: ADULT_REQUIRED_CODE, adult_confirmation_required: true });
  return false;
}

// ---------- Criar ----------
router.post('/', auth, async (req, res) => {
  const userId = req.user.userId;
  const { mission_id: rawMission, kind } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(KIND_TO_MODE, kind)) {
    return res.status(400).json({ error: MSG.kindInvalid });
  }
  const missionId = parseId(rawMission);
  if (!missionId) return res.status(404).json({ error: MSG.missionNotFound });

  let client;
  try {
    if (!(await adultOr403(userId, res))) return;
    client = await db.connect();
    await client.query('BEGIN');
    // Só o dono, e só numa missão Solo ativa sem par.
    const missionRes = await client.query(
      `SELECT m.id, m.user_id, m.status, m.mode, ${PAIRED_SQL} AS paired
       FROM missions m
       WHERE m.id = $1 AND m.user_id = $2
       FOR UPDATE`,
      [missionId, userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: MSG.missionNotFound });
    }
    if (mission.status !== 'active' || mission.paired === true) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: MSG.notSolo });
    }
    // Um convite aberto por missão: o anterior é cancelado.
    await client.query(
      `UPDATE mission_invites SET canceled_at = NOW()
       WHERE mission_id = $1 AND used_at IS NULL AND canceled_at IS NULL`,
      [missionId]
    );
    const token = newToken();
    const inviteRes = await client.query(
      `INSERT INTO mission_invites (mission_id, created_by, kind, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${INVITE_DAYS} days')
       RETURNING id, kind, expires_at`,
      [missionId, userId, kind, hashToken(token)]
    );
    await client.query('COMMIT');
    const invite = inviteRes.rows[0];
    return res.status(201).json({
      invite: { id: invite.id, kind: invite.kind, expires_at: invite.expires_at },
      token,
      message: MSG.created
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* nada */ } }
    if (isMissingSchema(err)) return res.status(503).json({ error: MSG.unavailable });
    return res.status(500).json({ error: MSG.error });
  } finally {
    if (client) client.release();
  }
});

// ---------- Cancelar (só o dono) ----------
router.delete('/:inviteId', auth, async (req, res) => {
  const userId = req.user.userId;
  const inviteId = parseId(req.params.inviteId);
  if (!inviteId) return res.status(404).json({ error: MSG.notFound });
  try {
    const result = await db.query(
      `UPDATE mission_invites SET canceled_at = NOW()
       WHERE id = $1 AND created_by = $2 AND used_at IS NULL AND canceled_at IS NULL
       RETURNING id`,
      [inviteId, userId]
    );
    if (result.rows[0]) return res.json({ canceled: true, message: MSG.canceled });
    const seen = await db.query(
      'SELECT used_at, canceled_at FROM mission_invites WHERE id = $1 AND created_by = $2',
      [inviteId, userId]
    );
    const row = seen.rows[0];
    if (!row) return res.status(404).json({ error: MSG.notFound });
    if (row.used_at) return res.status(409).json({ error: MSG.alreadyUsed });
    return res.json({ canceled: true, message: MSG.canceled });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MSG.unavailable });
    return res.status(500).json({ error: MSG.error });
  }
});

// Estado de um convite já lido: null se vale, ou { status, error }.
function inviteProblem(invite, userId) {
  if (!invite) return { status: 404, error: MSG.notFound };
  if (invite.canceled_at) return { status: 410, error: MSG.wasCanceled };
  if (invite.used_at) return { status: 409, error: MSG.alreadyUsed };
  if (invite.expired === true) return { status: 410, error: MSG.expired };
  if (Number(invite.created_by) === Number(userId)) return { status: 400, error: MSG.own };
  return null;
}

// ---------- Ver o convite (tela de aceitar) ----------
router.post('/preview', auth, async (req, res) => {
  const userId = req.user.userId;
  const token = parseToken(req.body && req.body.token);
  if (!token) return res.status(404).json({ error: MSG.notFound });
  try {
    const result = await db.query(
      `SELECT i.kind, i.created_by, i.used_at, i.canceled_at, i.expires_at,
              (i.expires_at <= NOW()) AS expired,
              m.title, m.category, u.username AS owner_name
       FROM mission_invites i
       JOIN missions m ON m.id = i.mission_id
       JOIN users u ON u.id = i.created_by
       WHERE i.token_hash = $1`,
      [hashToken(token)]
    );
    const invite = result.rows[0];
    const problem = inviteProblem(invite, userId);
    if (problem) return res.status(problem.status).json({ error: problem.error });
    return res.json({
      invite: {
        kind: invite.kind,
        owner_name: invite.owner_name,
        title: invite.title,
        category: invite.category,
        expires_at: invite.expires_at
      }
    });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MSG.unavailable });
    return res.status(500).json({ error: MSG.error });
  }
});

// Bloqueio entre as duas pessoas (migração 011). Sem a tabela, não há bloqueio.
async function blockedBetween(client, a, b) {
  const ready = await client.query("SELECT to_regclass('public.user_blocks') IS NOT NULL AS ready");
  if (!ready.rows[0] || ready.rows[0].ready !== true) return false;
  const res = await client.query(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [a, b]
  );
  return res.rows.length > 0;
}

// ---------- Aceitar ----------
router.post('/accept', auth, async (req, res) => {
  const userId = req.user.userId;
  const token = parseToken(req.body && req.body.token);
  if (!token) return res.status(404).json({ error: MSG.notFound });
  const ownMissionRaw = req.body && req.body.mission_id;
  const ownMissionId = ownMissionRaw == null ? null : parseId(ownMissionRaw);
  if (ownMissionRaw != null && !ownMissionId) return res.status(400).json({ error: MSG.ownMissionInvalid });

  let client;
  const fail = async (status, error) => {
    await client.query('ROLLBACK');
    return res.status(status).json({ error });
  };
  try {
    if (!(await adultOr403(userId, res))) return;
    client = await db.connect();
    await client.query('BEGIN');
    // Trava a pessoa (um aceite por vez dela) e o convite (só um aceite passa).
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const inviteRes = await client.query(
      `SELECT id, mission_id, created_by, kind, used_at, canceled_at,
              (expires_at <= NOW()) AS expired
       FROM mission_invites
       WHERE token_hash = $1
       FOR UPDATE`,
      [hashToken(token)]
    );
    const invite = inviteRes.rows[0];
    const problem = inviteProblem(invite, userId);
    if (problem) return fail(problem.status, problem.error);

    if (await blockedBetween(client, invite.created_by, userId)) return fail(403, MSG.blocked);

    // Quem aceita não pode estar em outro par ativo.
    const pairedRes = await client.query(
      `SELECT 1 FROM missions m
       WHERE (m.user_id = $1 OR m.partner_id = $1) AND m.status = 'active' AND ${PAIRED_SQL}
       LIMIT 1`,
      [userId]
    );
    if (pairedRes.rows[0]) return fail(409, MSG.alreadyPaired);

    // A missão do dono ainda é Solo, ativa e do mesmo dono.
    const ownerRes = await client.query(
      `SELECT m.*, ${PAIRED_SQL} AS paired FROM missions m WHERE m.id = $1 FOR UPDATE`,
      [invite.mission_id]
    );
    const owner = ownerRes.rows[0];
    if (!owner || Number(owner.user_id) !== Number(invite.created_by) || owner.status !== 'active' || owner.paired === true) {
      return fail(409, MSG.missionTaken);
    }

    let joinedMissionId;
    if (invite.kind === 'duo') {
      await client.query(
        `UPDATE missions
         SET mode = 'parceiro', partner_id = $2, pair_started_at = NOW(), match_preference = NULL
         WHERE id = $1`,
        [owner.id, userId]
      );
      joinedMissionId = owner.id;
    } else {
      let mine;
      if (ownMissionId) {
        const mineRes = await client.query(
          `SELECT m.*, ${PAIRED_SQL} AS paired FROM missions m
           WHERE m.id = $1 AND m.user_id = $2 FOR UPDATE`,
          [ownMissionId, userId]
        );
        mine = mineRes.rows[0];
        if (!mine || mine.status !== 'active' || mine.paired === true) return fail(400, MSG.ownMissionInvalid);
      } else {
        // Missão nova com o mesmo desafio, sem os textos pessoais do dono.
        const created = await client.query(
          `INSERT INTO missions (user_id, title, category, level, mode, daily_minimum, proof_mode,
                                 duration_days, status, started_at, ends_at)
           VALUES ($1, $2, $3, $4, 'solo', $5, $6, $7, 'active', NOW(), NOW() + ($7::int * INTERVAL '1 day'))
           RETURNING *`,
          [userId, owner.title, owner.category, owner.level || 'iniciante', owner.daily_minimum || null,
            owner.proof_mode || 'self_report', Number(owner.duration_days) || 30]
        );
        mine = created.rows[0];
      }
      await client.query(
        `INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, started_at)
         VALUES ($1, $2, 'rival', NOW())`,
        [owner.id, mine.id]
      );
      await client.query(
        `UPDATE missions SET mode = 'rival', partner_id = $2, pair_started_at = NOW(), match_preference = NULL
         WHERE id = $1`,
        [owner.id, userId]
      );
      await client.query(
        `UPDATE missions SET mode = 'rival', partner_id = $2, pair_started_at = NOW(), match_preference = NULL
         WHERE id = $1`,
        [mine.id, owner.user_id]
      );
      joinedMissionId = mine.id;
    }

    await client.query(
      'UPDATE mission_invites SET used_at = NOW(), used_by = $2 WHERE id = $1',
      [invite.id, userId]
    );
    await client.query('COMMIT');
    return res.json({
      accepted: true,
      kind: invite.kind,
      mission_id: joinedMissionId,
      message: invite.kind === 'duo' ? MSG.acceptedDuo : MSG.acceptedRival
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* nada */ } }
    // Sem log: nada do pedido (nem o token) vai para o console.
    if (isMissingSchema(err)) return res.status(503).json({ error: MSG.unavailable });
    return res.status(500).json({ error: MSG.error });
  } finally {
    if (client) client.release();
  }
});

router.MSG = MSG;
router.hashToken = hashToken;
module.exports = router;
