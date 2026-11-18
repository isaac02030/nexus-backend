// ============================================
// NEXUS - Rotas de Missoes
// Criar, ver e fazer match
// ============================================

const express = require('express');
const { Pool } = require('pg');
const auth = require('../middleware/auth');
const router = express.Router();

const db = new Pool({ connectionString: process.env.DATABASE_URL });
let missionContractReady = false;
let missionParticipantHealingReady = false;
let missionMatchSchemaReady = false;

// Auto-matching stays off unless the environment explicitly sets MATCHING_ENABLED=true.
function isMatchingEnabled() {
  return String(process.env.MATCHING_ENABLED || '').toLowerCase() === 'true';
}

function missionParticipantWhere(alias = 'm', userParam = '$1') {
  return `(
    ${alias}.user_id = ${userParam}
    OR ${alias}.partner_id = ${userParam}
    OR EXISTS (
      SELECT 1 FROM checkins c
      WHERE c.mission_id = ${alias}.id
        AND c.user_id = ${userParam}
    )
    OR EXISTS (
      SELECT 1 FROM messages msg
      WHERE msg.mission_id = ${alias}.id
        AND msg.sender_id = ${userParam}
    )
  )`;
}

async function ensureMissionContractColumns() {
  if (missionContractReady) return;

  await db.query(`
    ALTER TABLE missions
      ADD COLUMN IF NOT EXISTS daily_minimum VARCHAR(120),
      ADD COLUMN IF NOT EXISTS commitment_window VARCHAR(120),
      ADD COLUMN IF NOT EXISTS why_it_matters TEXT,
      ADD COLUMN IF NOT EXISTS fallback_plan TEXT,
      ADD COLUMN IF NOT EXISTS proof_mode VARCHAR(40),
      ADD COLUMN IF NOT EXISTS study_focus VARCHAR(160),
      ADD COLUMN IF NOT EXISTS study_current_stage VARCHAR(160),
      ADD COLUMN IF NOT EXISTS study_target_outcome TEXT,
      ADD COLUMN IF NOT EXISTS match_preference VARCHAR(20),
      ADD COLUMN IF NOT EXISTS partner_started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS pair_started_at TIMESTAMP
  `);

  missionContractReady = true;
}

async function ensureMissionMatchSchema() {
  if (missionMatchSchemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS mission_matches (
      id SERIAL PRIMARY KEY,
      mission_a_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      mission_b_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      mode VARCHAR(20) NOT NULL CHECK (mode IN ('parceiro', 'rival')),
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK (mission_a_id <> mission_b_id)
    )
  `);

  missionMatchSchemaReady = true;
}

async function healPairedMissionParticipants() {
  if (missionParticipantHealingReady) return;

  await db.query(`
    WITH participant_history AS (
      SELECT mission_id, user_id
      FROM checkins
      GROUP BY mission_id, user_id

      UNION

      SELECT mission_id, sender_id AS user_id
      FROM messages
      GROUP BY mission_id, sender_id
    ),
    recoverable AS (
      SELECT
        m.id AS mission_id,
        MIN(ph.user_id) AS recovered_user_id,
        COUNT(DISTINCT ph.user_id) AS recovered_count
      FROM missions m
      JOIN participant_history ph
        ON ph.mission_id = m.id
      WHERE m.partner_id IS NULL
        AND m.mode IN ('parceiro', 'rival')
        AND ph.user_id <> m.user_id
      GROUP BY m.id
    )
    UPDATE missions m
    SET partner_id = r.recovered_user_id
    FROM recoverable r
    WHERE m.id = r.mission_id
      AND r.recovered_count = 1
  `);

  missionParticipantHealingReady = true;
}

async function healWaitingSoloMissions() {
  await db.query(`
    UPDATE missions
    SET status = 'active',
        started_at = COALESCE(started_at, created_at, NOW()),
        ends_at = COALESCE(ends_at, COALESCE(started_at, created_at, NOW()) + INTERVAL '30 days')
    WHERE mode = 'solo'
      AND status = 'waiting'
  `);

  await db.query(`
    UPDATE missions
    SET match_preference = COALESCE(match_preference, mode),
        mode = 'solo',
        status = 'active',
        started_at = COALESCE(started_at, created_at, NOW()),
        ends_at = COALESCE(ends_at, COALESCE(started_at, created_at, NOW()) + INTERVAL '30 days')
    WHERE status = 'waiting'
      AND mode IN ('parceiro', 'rival')
      AND partner_id IS NULL
  `);
}

async function endLinkedMissionMatch(missionId, userId, { abandon = false } = {}) {
  await ensureMissionMatchSchema();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const pairRes = await client.query(
      `SELECT mm.*, ma.user_id AS user_a, mb.user_id AS user_b,
              ma.id AS mission_a, mb.id AS mission_b
       FROM mission_matches mm
       JOIN missions ma ON ma.id = mm.mission_a_id
       JOIN missions mb ON mb.id = mm.mission_b_id
       WHERE mm.status = 'active'
         AND (mm.mission_a_id = $1 OR mm.mission_b_id = $1)
         AND (ma.user_id = $2 OR mb.user_id = $2)
       LIMIT 1
       FOR UPDATE OF mm`,
      [missionId, userId]
    );
    const pair = pairRes.rows[0];
    if (!pair) {
      await client.query('COMMIT');
      return false;
    }

    const isMissionAOwner = Number(pair.user_a) === Number(userId);
    const ownedMissionId = isMissionAOwner ? pair.mission_a : pair.mission_b;
    const counterpartMissionId = isMissionAOwner ? pair.mission_b : pair.mission_a;
    await client.query(
      `UPDATE missions
       SET mode = 'solo', partner_id = NULL, match_preference = NULL, pair_started_at = NULL,
           status = CASE WHEN id = $1 AND $3 THEN 'abandoned' ELSE status END,
           ends_at = CASE WHEN id = $1 AND $3 THEN NOW() ELSE ends_at END
       WHERE id IN ($1, $2)`,
      [ownedMissionId, counterpartMissionId, abandon]
    );
    await client.query(
      `UPDATE mission_matches SET status = 'ended', ended_at = NOW() WHERE id = $1`,
      [pair.id]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/', auth, async (req, res) => {
  const {
    title,
    category,
    level,
    mode,
    description,
    daily_minimum,
    commitment_window,
    why_it_matters,
    fallback_plan,
    proof_mode,
    study_focus,
    study_current_stage,
    study_target_outcome
  } = req.body;
  const userId = req.user.userId;

  if (!title || !category) {
    return res.status(400).json({ error: 'Titulo e categoria sao obrigatorios.' });
  }

  try {
    await ensureMissionContractColumns();
    await ensureMissionMatchSchema();
    await healPairedMissionParticipants();
    await healWaitingSoloMissions();

    const requestedMode = ['parceiro', 'rival'].includes(mode) ? mode : 'solo';
    const result = await db.query(
      `INSERT INTO missions (
         user_id, title, category, level, mode, match_preference, description,
         daily_minimum, commitment_window, why_it_matters, fallback_plan, proof_mode,
         study_focus, study_current_stage, study_target_outcome
       )
       VALUES ($1, $2, $3, $4, 'solo', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        userId,
        title,
        category,
        level || 'iniciante',
        requestedMode === 'solo' ? null : requestedMode,
        description || null,
        daily_minimum || null,
        commitment_window || null,
        why_it_matters || null,
        fallback_plan || null,
        proof_mode || 'self_report',
        study_focus || null,
        study_current_stage || null,
        study_target_outcome || null
      ]
    );

    const now = new Date();
    const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const activated = await db.query(
      `UPDATE missions
       SET status = 'active', started_at = $1, ends_at = $2
       WHERE id = $3
       RETURNING *`,
      [now, endsAt, result.rows[0].id]
    );

    let mission = activated.rows[0];
    const matchingEnabled = isMatchingEnabled();
    const match = matchingEnabled && mission.match_preference
      ? await tryMatchMission(mission, userId, db)
      : null;
    if (match) mission = match.currentMission;

    return res.status(201).json({
      mission,
      matched: !!match,
      matchedWith: match ? match.partnerMission.user_id : null,
      matchingEnabled,
      message: match
        ? 'Par encontrado. A tua missão continua com o progresso atual.'
        : matchingEnabled && mission.match_preference
          ? 'A missão começou em solo. Vamos procurar alguém compatível enquanto segues.'
          : 'Missao solo criada.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar missao.' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    await ensureMissionContractColumns();
    await healPairedMissionParticipants();
    await healWaitingSoloMissions();

    const result = await db.query(
      `SELECT m.*,
              u1.username AS user_name,
              u2.username AS partner_name
       FROM missions m
       LEFT JOIN users u1 ON m.user_id = u1.id
       LEFT JOIN users u2 ON m.partner_id = u2.id
       WHERE m.id = $1
         AND ${missionParticipantWhere('m', '$2')}`,
      [req.params.id, req.user.userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Missao nao encontrada.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter missao.' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    await ensureMissionContractColumns();
    await ensureMissionMatchSchema();
    await healPairedMissionParticipants();
    await healWaitingSoloMissions();

    const result = await db.query(
      `SELECT m.*,
        u2.username AS partner_name,
        COALESCE(counterpart.user_id, m.partner_id) AS counterpart_user_id,
        counterpart.id AS partner_mission_id,
        pair.started_at AS match_started_at,
        COALESCE(counterpart.started_at, m.partner_started_at, m.started_at) AS partner_started_at,
        CASE WHEN pair.id IS NOT NULL THEN (
          SELECT COUNT(*) FROM checkins own_checkin
          WHERE own_checkin.mission_id = m.id
            AND own_checkin.user_id = m.user_id
            AND own_checkin.completed = true
            AND own_checkin.created_at >= pair.started_at
        ) ELSE m.user_score END AS user_score,
        CASE WHEN pair.id IS NOT NULL THEN (
          SELECT COUNT(*) FROM checkins partner_checkin
          WHERE partner_checkin.mission_id = counterpart.id
            AND partner_checkin.user_id = counterpart.user_id
            AND partner_checkin.completed = true
            AND partner_checkin.created_at >= pair.started_at
        ) ELSE m.partner_score END AS partner_score,
        (
          SELECT MAX(c.day_number)
          FROM checkins c
          WHERE c.mission_id = COALESCE(counterpart.id, m.id)
            AND c.completed = true
            AND c.user_id = COALESCE(counterpart.user_id, m.partner_id)
       ) AS partner_last_checkin_day,
       (SELECT MAX(c.created_at)
        FROM checkins c
        WHERE c.mission_id = COALESCE(counterpart.id, m.id)
          AND c.user_id = COALESCE(counterpart.user_id, m.partner_id)
          AND c.completed = true) AS partner_last_checkin_at
       FROM missions m
       LEFT JOIN mission_matches pair
         ON pair.status = 'active' AND (pair.mission_a_id = m.id OR pair.mission_b_id = m.id)
       LEFT JOIN missions counterpart
         ON counterpart.id = CASE
           WHEN pair.mission_a_id = m.id THEN pair.mission_b_id
           WHEN pair.mission_b_id = m.id THEN pair.mission_a_id
           ELSE NULL
         END
       LEFT JOIN users u1 ON m.user_id = u1.id
       LEFT JOIN users u2 ON u2.id = COALESCE(counterpart.user_id, m.partner_id)
       WHERE (
         m.user_id = $1
         OR (m.partner_id = $1 AND pair.id IS NULL)
         OR EXISTS (SELECT 1 FROM checkins c WHERE c.mission_id = m.id AND c.user_id = $1)
         OR EXISTS (SELECT 1 FROM messages msg WHERE msg.mission_id = m.id AND msg.sender_id = $1)
       ) AND m.status <> 'merged'
       ORDER BY m.created_at DESC`,
      [req.user.userId]
    );

    res.json(result.rows.map(mission => ({
      ...mission,
      matching_enabled: isMatchingEnabled()
    })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar missoes.' });
  }
});

router.post('/:id/match', auth, async (req, res) => {
  try {
    await ensureMissionContractColumns();
    await ensureMissionMatchSchema();
    const missionRes = await db.query(
      `SELECT * FROM missions
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       LIMIT 1`,
      [req.params.id, req.user.userId]
    );
    const mission = missionRes.rows[0];
    if (!mission) return res.status(404).json({ error: 'Missão ativa não encontrada.' });
    if (!isMatchingEnabled()) {
      return res.json({ matched: false, matchingEnabled: false, mission });
    }
    if (!mission.match_preference) return res.json({ matched: false, mission });

    const match = await tryMatchMission(mission, req.user.userId, db);
    if (!match) return res.json({ matched: false, mission });
    res.json({ matched: true, matchingEnabled: true, mission: match.currentMission, matchedWith: match.partnerMission.user_id });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao procurar um par compatível.' });
  }
});

router.delete('/:id/waiting', auth, async (req, res) => {
  const missionId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `DELETE FROM missions
       WHERE id = $1 AND user_id = $2 AND status = 'waiting'
       RETURNING id`,
      [missionId, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Missao em espera nao encontrada.' });
    }

    res.json({ success: true, message: 'Saíste da fila de espera.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sair da fila.' });
  }
});

router.post('/:id/abandon', auth, async (req, res) => {
  const missionId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `SELECT *
       FROM missions
       WHERE id = $1
         AND status = 'active'
         AND (user_id = $2 OR partner_id = $2)
       LIMIT 1`,
      [missionId, userId]
    );

    const mission = result.rows[0];

    if (!mission) {
      return res.status(404).json({ error: 'Missao ativa nao encontrada.' });
    }

    if (await endLinkedMissionMatch(missionId, userId, { abandon: true })) {
      return res.json({ success: true, message: 'Saíste da missão. A outra pessoa continua em solo.' });
    }

    if (!mission.partner_id || mission.mode === 'solo') {
      if (mission.user_id !== userId) {
        return res.status(403).json({ error: 'Nao autorizado para encerrar esta missao.' });
      }

      await db.query(
        `UPDATE missions
         SET status = 'abandoned',
             ends_at = NOW()
         WHERE id = $1`,
        [missionId]
      );

      return res.json({
        success: true,
        message: 'Missao solo encerrada.'
      });
    }

    if (mission.partner_id === userId) {
      await db.query(
        `UPDATE missions
         SET partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId]
      );
    } else {
      await db.query(
        `UPDATE missions
         SET user_id = partner_id,
             partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId]
      );
    }

    res.json({
      success: true,
      message: 'Saíste da missão. A outra pessoa continua em solo.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sair da missao.' });
  }
});

router.post('/:id/continue-solo', auth, async (req, res) => {
  const missionId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `SELECT *
       FROM missions
       WHERE id = $1
         AND status = 'active'
         AND (user_id = $2 OR partner_id = $2)
       LIMIT 1`,
      [missionId, userId]
    );

    const mission = result.rows[0];

    if (!mission) {
      return res.status(404).json({ error: 'Missao ativa nao encontrada.' });
    }

    if (await endLinkedMissionMatch(missionId, userId)) {
      return res.json({
        success: true,
        message: 'A missão agora continua em solo, sem perder o teu progresso.'
      });
    }

    if (!mission.partner_id || mission.mode === 'solo') {
      return res.status(400).json({ error: 'Esta missao ja esta em solo.' });
    }

    if (mission.user_id === userId) {
      await db.query(
        `UPDATE missions
         SET partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId]
      );
    } else {
      await db.query(
        `UPDATE missions
         SET user_id = $2,
             partner_id = NULL,
             mode = 'solo'
         WHERE id = $1`,
        [missionId, userId]
      );
    }

    res.json({
      success: true,
      message: 'A missão agora continua em solo, sem perder o teu progresso.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao continuar em solo.' });
  }
});

function missionLevelRank(level) {
  const normalized = String(level || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (normalized === 'iniciante') return 1;
  if (normalized === 'intermedio' || normalized === 'intermediario') return 2;
  if (normalized === 'avancado') return 3;
  return null;
}

async function tryMatchMission(currentMission, currentUserId, pool) {
  const requestedMode = currentMission.match_preference;
  const currentRank = missionLevelRank(currentMission.level);
  if (!['parceiro', 'rival'].includes(requestedMode) || !currentRank) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedCurrentRes = await client.query(
      `SELECT * FROM missions
       WHERE id = $1 AND user_id = $2 AND status = 'active'
         AND mode = 'solo' AND partner_id IS NULL
       FOR UPDATE`,
      [currentMission.id, currentUserId]
    );
    const lockedCurrent = lockedCurrentRes.rows[0];
    if (!lockedCurrent || lockedCurrent.match_preference !== requestedMode) {
      await client.query('COMMIT');
      return null;
    }

    const candidateRes = await client.query(
      `SELECT m.*
       FROM missions m
       WHERE m.status = 'active'
         AND m.mode = 'solo'
         AND m.match_preference = $1
         AND LOWER(BTRIM(m.category)) = LOWER(BTRIM($2))
         AND m.user_id <> $3
         AND m.partner_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM mission_matches mm
           WHERE mm.status = 'active'
             AND (mm.mission_a_id = m.id OR mm.mission_b_id = m.id)
         )
         AND CASE
           WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'iniciante' THEN 1
           WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) IN ('intermedio', 'intermediario') THEN 2
           WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'avancado' THEN 3
           ELSE NULL
         END BETWEEN GREATEST(1, $4 - 1) AND LEAST(3, $4 + 1)
       ORDER BY CASE
           WHEN CASE
             WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'iniciante' THEN 1
             WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) IN ('intermedio', 'intermediario') THEN 2
             WHEN LOWER(TRANSLATE(BTRIM(m.level), 'íéâãá', 'ieaaa')) = 'avancado' THEN 3
             ELSE NULL
           END = $4 THEN 0 ELSE 1 END,
         m.created_at ASC
       LIMIT 1
       FOR UPDATE OF m SKIP LOCKED`,
      [requestedMode, lockedCurrent.category, currentUserId, currentRank]
    );
    const candidate = candidateRes.rows[0];
    if (!candidate) {
      await client.query('COMMIT');
      return null;
    }

    const now = new Date();
    await client.query(
      `INSERT INTO mission_matches (mission_a_id, mission_b_id, mode, started_at)
       VALUES ($1, $2, $3, $4)`,
      [lockedCurrent.id, candidate.id, requestedMode, now]
    );
    await client.query(
      `UPDATE missions
       SET mode = $1, partner_id = $2, pair_started_at = $3
       WHERE id = $4`,
      [requestedMode, candidate.user_id, now, lockedCurrent.id]
    );
    await client.query(
      `UPDATE missions
       SET mode = $1, partner_id = $2, pair_started_at = $3
       WHERE id = $4`,
      [requestedMode, currentUserId, now, candidate.id]
    );
    await client.query('COMMIT');

    return {
      currentMission: { ...lockedCurrent, mode: requestedMode, partner_id: candidate.user_id, pair_started_at: now },
      partnerMission: candidate
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
