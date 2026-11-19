// ============================================
// NEXUS — Convite de Duo por link
// Solo segue livre. Duo so entra por convite.
// O emparelhamento automatico nao e alterado aqui.
// ============================================
//
// Interruptor: NEXUS_CONVITE_POR_LINK
// Sem o valor true, todas estas rotas respondem 404.
// A validade do codigo e INVITE_TTL_HOURS (48). Mude so esse numero.
//
// POST /api/missions/:id/convite    cria o convite
// GET  /api/convites/:code          previa: nome e titulo
// POST /api/convites/:code/aceitar  entra como partner_id
// POST /api/convites/:code/recusar  marca o convite como recusado
//
// O codigo claro sai uma unica vez na criacao. A tabela guarda so o SHA-256.
// O codigo tem 256 bits aleatorios, por isso um hash rapido chega para a busca.

const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const auth = require('../middleware/auth');

const INVITE_TTL_HOURS = 48;
const INVITE_NOT_FOUND = 'Convite não encontrado.';

const db = new Pool({ connectionString: process.env.DATABASE_URL });

const missionInvites = express.Router();
const convites = express.Router();

function convitePorLinkEnabled() {
  return String(process.env.NEXUS_CONVITE_POR_LINK || '').toLowerCase() === 'true';
}

function requireConvite(req, res, next) {
  if (!convitePorLinkEnabled()) {
    return res.status(404).json({ error: INVITE_NOT_FOUND });
  }
  return auth(req, res, next);
}

function inviteNotFound(res) {
  return res.status(404).json({ error: INVITE_NOT_FOUND });
}

function parseMissionId(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function normalizeCode(value) {
  const code = String(value || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
  return code;
}

function hashInviteCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function newInviteCode() {
  return crypto.randomBytes(32).toString('base64url');
}

function inviteExpiry(now = new Date()) {
  return new Date(now.getTime() + INVITE_TTL_HOURS * 60 * 60 * 1000);
}

function canCreateInvite(mission) {
  if (!mission || mission.partner_id != null) return false;
  const status = String(mission.status || '');
  const mode = String(mission.mode || '');
  if (status === 'active' && mode === 'solo') return true;
  if ((status === 'active' || status === 'waiting') && (mode === 'parceiro' || mode === 'duo')) {
    return true;
  }
  return false;
}

function isOpenMission(row) {
  if (!row || row.partner_id != null) return false;
  const status = String(row.mission_status || '');
  return status === 'active' || status === 'waiting';
}

function isPendingUnexpired(row, now = new Date()) {
  if (!row || row.status !== 'pending' || !row.expires_at) return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}

async function withTransaction(work) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    if (result && result.rollback) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // A ligacao ja pode ter caido. O erro original e que importa.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function loadInvite(client, codeHash) {
  const result = await client.query(
    `SELECT i.id,
            i.mission_id,
            i.inviter_id,
            i.status,
            i.expires_at,
            m.user_id,
            m.partner_id,
            m.status AS mission_status,
            m.mode,
            m.title AS mission_title,
            u.username AS display_name
     FROM mission_invites i
     JOIN missions m ON m.id = i.mission_id
     JOIN users u ON u.id = i.inviter_id
     WHERE i.code_hash = $1
     LIMIT 1
     FOR UPDATE OF i, m`,
    [codeHash]
  );
  return result.rows[0] || null;
}

missionInvites.post('/:id/convite', requireConvite, async (req, res) => {
  const missionId = parseMissionId(req.params.id);
  const userId = Number(req.user.userId);
  if (!missionId || !Number.isInteger(userId)) {
    return res.status(404).json({ error: 'Missão não encontrada.' });
  }

  try {
    const found = await db.query(
      `SELECT id, user_id, partner_id, status, mode
       FROM missions
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [missionId, userId]
    );
    const mission = found.rows[0];
    if (!mission) {
      return res.status(404).json({ error: 'Missão não encontrada.' });
    }
    if (!canCreateInvite(mission)) {
      return res.status(400).json({ error: 'Esta missão não pode receber convite.' });
    }

    const code = newInviteCode();
    const expiresAt = inviteExpiry();
    const inserted = await db.query(
      `INSERT INTO mission_invites (mission_id, inviter_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, expires_at`,
      [missionId, userId, hashInviteCode(code), expiresAt]
    );

    return res.status(201).json({
      code,
      path: `/convite/${code}`,
      expires_at: new Date(inserted.rows[0].expires_at).toISOString()
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao criar convite.' });
  }
});

convites.get('/:code', requireConvite, async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return inviteNotFound(res);

  try {
    const result = await db.query(
      `SELECT u.username AS display_name, m.title AS mission_title
       FROM mission_invites i
       JOIN users u ON u.id = i.inviter_id
       JOIN missions m ON m.id = i.mission_id
       WHERE i.code_hash = $1
         AND i.status = 'pending'
         AND i.expires_at > NOW()
         AND m.partner_id IS NULL
         AND m.status IN ('active', 'waiting')
       LIMIT 1`,
      [hashInviteCode(code)]
    );
    const row = result.rows[0];
    if (!row) return inviteNotFound(res);

    return res.json({
      display_name: row.display_name,
      mission_title: row.mission_title
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao ver convite.' });
  }
});

convites.post('/:code/aceitar', requireConvite, async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return inviteNotFound(res);
  const userId = Number(req.user.userId);
  if (!Number.isInteger(userId)) return inviteNotFound(res);

  try {
    const outcome = await withTransaction(async (client) => {
      const invite = await loadInvite(client, hashInviteCode(code));
      if (!invite || !isPendingUnexpired(invite) || !isOpenMission(invite)) {
        return { rollback: true, status: 404 };
      }
      if (Number(invite.inviter_id) === userId || Number(invite.user_id) === userId) {
        return { rollback: true, status: 403 };
      }

      const used = await client.query(
        `UPDATE mission_invites
         SET status = 'used', used_by = $2, used_at = NOW()
         WHERE id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND inviter_id <> $2`,
        [invite.id, userId]
      );
      if (used.rowCount !== 1) return { rollback: true, status: 404 };

      const joined = await client.query(
        `UPDATE missions
         SET partner_id = $2,
             mode = 'parceiro',
             status = 'active',
             match_preference = NULL,
             pair_started_at = COALESCE(pair_started_at, NOW()),
             started_at = COALESCE(started_at, NOW())
         WHERE id = $1
           AND partner_id IS NULL
           AND user_id <> $2
           AND status IN ('active', 'waiting')`,
        [invite.mission_id, userId]
      );
      if (joined.rowCount !== 1) return { rollback: true, status: 404 };

      return {
        mission_id: Number(invite.mission_id),
        partner_id: userId,
        mode: 'parceiro',
        mission_title: invite.mission_title
      };
    });

    if (outcome.status === 404) return inviteNotFound(res);
    if (outcome.status === 403) {
      return res.status(403).json({ error: 'Não podes aceitar o teu próprio convite.' });
    }

    return res.json({
      accepted: true,
      mission_id: outcome.mission_id,
      partner_id: outcome.partner_id,
      mode: outcome.mode,
      mission_title: outcome.mission_title
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao aceitar convite.' });
  }
});

convites.post('/:code/recusar', requireConvite, async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return inviteNotFound(res);
  const userId = Number(req.user.userId);
  if (!Number.isInteger(userId)) return inviteNotFound(res);

  try {
    const outcome = await withTransaction(async (client) => {
      const invite = await loadInvite(client, hashInviteCode(code));
      if (!invite || !isPendingUnexpired(invite)) {
        return { rollback: true, status: 404 };
      }
      if (Number(invite.inviter_id) === userId) {
        return { rollback: true, status: 403 };
      }

      const declined = await client.query(
        `UPDATE mission_invites
         SET status = 'declined', declined_at = NOW()
         WHERE id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND inviter_id <> $2`,
        [invite.id, userId]
      );
      if (declined.rowCount !== 1) return { rollback: true, status: 404 };
      return { declined: true };
    });

    if (outcome.status === 404) return inviteNotFound(res);
    if (outcome.status === 403) {
      return res.status(403).json({ error: 'Não podes recusar o teu próprio convite.' });
    }
    return res.json({ declined: true });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao recusar convite.' });
  }
});

module.exports = {
  missionInvites,
  convites,
  INVITE_TTL_HOURS
};
