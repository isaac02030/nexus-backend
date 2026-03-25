const express = require('express');
const { Pool } = require('pg');
const auth = require('../middleware/auth');

const router = express.Router();
const db = new Pool({ connectionString: process.env.DATABASE_URL });

function ensureAdmin(req, res) {
  if (req.user.userId !== 1) {
    res.status(403).json({ error: 'Esta area esta disponivel apenas para o admin.' });
    return false;
  }
  return true;
}

router.get('/overview', auth, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const summaryPromise = db.query(`
      WITH first_checkins AS (
        SELECT mission_id, user_id, MIN(day_number) AS first_day
        FROM checkins
        WHERE completed = true
        GROUP BY mission_id, user_id
      ),
      next_day_returns AS (
        SELECT f.mission_id, f.user_id
        FROM first_checkins f
        WHERE EXISTS (
          SELECT 1
          FROM checkins c
          WHERE c.mission_id = f.mission_id
            AND c.user_id = f.user_id
            AND c.completed = true
            AND c.day_number = f.first_day + 1
        )
      ),
      mission_participants AS (
        SELECT m.id AS mission_id, m.user_id AS user_id
        FROM missions m
        UNION ALL
        SELECT m.id AS mission_id, m.partner_id AS user_id
        FROM missions m
        WHERE m.partner_id IS NOT NULL
      )
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users_7d,
        (SELECT COUNT(*) FROM mission_participants) AS total_participants,
        (SELECT COUNT(*) FROM missions WHERE status = 'waiting') AS waiting_missions,
        (SELECT COUNT(*) FROM missions WHERE status = 'active') AS active_missions,
        (SELECT COUNT(*) FROM missions WHERE status = 'completed') AS completed_missions,
        (SELECT COUNT(DISTINCT user_id) FROM checkins WHERE completed = true AND created_at::date = CURRENT_DATE) AS checked_today,
        (SELECT COUNT(*) FROM first_checkins) AS started_count,
        (SELECT COUNT(*) FROM next_day_returns) AS returned_next_day_count
    `);

    const registeredNoMissionPromise = db.query(`
      SELECT u.id, u.username, u.created_at
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM missions m
        WHERE m.user_id = u.id OR m.partner_id = u.id
      )
      ORDER BY u.created_at DESC
      LIMIT 8
    `);

    const waitingQueuePromise = db.query(`
      SELECT m.id, m.title, m.category, m.mode, m.created_at, u.username
      FROM missions m
      JOIN users u ON u.id = m.user_id
      WHERE m.status = 'waiting'
      ORDER BY m.created_at DESC
      LIMIT 8
    `);

    const activeNoFirstCheckinPromise = db.query(`
      WITH mission_participants AS (
        SELECT
          m.id AS mission_id,
          m.title,
          m.category,
          m.mode,
          m.status,
          m.started_at,
          m.duration_days,
          m.created_at AS mission_created_at,
          m.user_id AS user_id,
          u1.username AS username
        FROM missions m
        JOIN users u1 ON u1.id = m.user_id

        UNION ALL

        SELECT
          m.id AS mission_id,
          m.title,
          m.category,
          m.mode,
          m.status,
          m.started_at,
          m.duration_days,
          m.created_at AS mission_created_at,
          m.partner_id AS user_id,
          u2.username AS username
        FROM missions m
        JOIN users u2 ON u2.id = m.partner_id
        WHERE m.partner_id IS NOT NULL
      )
      SELECT
        mp.mission_id,
        mp.title,
        mp.category,
        mp.mode,
        mp.username,
        mp.mission_created_at
      FROM mission_participants mp
      LEFT JOIN checkins c
        ON c.mission_id = mp.mission_id
       AND c.user_id = mp.user_id
       AND c.completed = true
      WHERE mp.status = 'active'
      GROUP BY mp.mission_id, mp.title, mp.category, mp.mode, mp.username, mp.mission_created_at
      HAVING COUNT(c.id) = 0
      ORDER BY mp.mission_created_at DESC
      LIMIT 8
    `);

    const inactiveParticipantsPromise = db.query(`
      WITH mission_participants AS (
        SELECT
          m.id AS mission_id,
          m.title,
          m.category,
          m.mode,
          m.status,
          m.started_at,
          m.duration_days,
          m.created_at AS mission_created_at,
          m.user_id AS user_id,
          u1.username AS username
        FROM missions m
        JOIN users u1 ON u1.id = m.user_id

        UNION ALL

        SELECT
          m.id AS mission_id,
          m.title,
          m.category,
          m.mode,
          m.status,
          m.started_at,
          m.duration_days,
          m.created_at AS mission_created_at,
          m.partner_id AS user_id,
          u2.username AS username
        FROM missions m
        JOIN users u2 ON u2.id = m.partner_id
        WHERE m.partner_id IS NOT NULL
      ),
      participant_progress AS (
        SELECT
          mp.mission_id,
          mp.title,
          mp.category,
          mp.mode,
          mp.status,
          mp.username,
          mp.mission_created_at,
          COALESCE(MAX(c.day_number), 0) AS last_checkin_day,
          LEAST(GREATEST(((CURRENT_DATE - mp.started_at::date) + 1), 1), mp.duration_days) AS current_day
        FROM mission_participants mp
        LEFT JOIN checkins c
          ON c.mission_id = mp.mission_id
         AND c.user_id = mp.user_id
         AND c.completed = true
        WHERE mp.status = 'active'
          AND mp.started_at IS NOT NULL
        GROUP BY
          mp.mission_id, mp.title, mp.category, mp.mode, mp.status,
          mp.username, mp.mission_created_at, mp.started_at, mp.duration_days
      )
      SELECT
        mission_id,
        title,
        category,
        mode,
        username,
        mission_created_at,
        current_day,
        last_checkin_day,
        (current_day - last_checkin_day) AS missed_days
      FROM participant_progress
      WHERE (current_day - last_checkin_day) >= 2
      ORDER BY mission_created_at DESC
      LIMIT 8
    `);

    const latestUsersPromise = db.query(`
      WITH mission_participants AS (
        SELECT
          m.id AS mission_id,
          m.user_id AS user_id,
          m.title,
          m.category,
          m.mode,
          m.status,
          m.created_at AS mission_created_at,
          m.started_at,
          m.duration_days
        FROM missions m

        UNION ALL

        SELECT
          m.id AS mission_id,
          m.partner_id AS user_id,
          m.title,
          m.category,
          m.mode,
          m.status,
          m.created_at AS mission_created_at,
          m.started_at,
          m.duration_days
        FROM missions m
        WHERE m.partner_id IS NOT NULL
      ),
      participant_progress AS (
        SELECT
          mp.*,
          COALESCE(COUNT(c.id), 0) AS completed_checkins,
          COALESCE(MAX(c.day_number), 0) AS last_checkin_day,
          CASE
            WHEN mp.started_at IS NOT NULL THEN LEAST(GREATEST(((CURRENT_DATE - mp.started_at::date) + 1), 1), mp.duration_days)
            ELSE 0
          END AS current_day
        FROM mission_participants mp
        LEFT JOIN checkins c
          ON c.mission_id = mp.mission_id
         AND c.user_id = mp.user_id
         AND c.completed = true
        GROUP BY
          mp.mission_id, mp.user_id, mp.title, mp.category, mp.mode,
          mp.status, mp.mission_created_at, mp.started_at, mp.duration_days
      )
      SELECT
        u.id,
        u.username,
        u.created_at,
        pp.title,
        pp.category,
        pp.mode,
        pp.status,
        pp.completed_checkins,
        pp.current_day,
        pp.last_checkin_day
      FROM users u
      LEFT JOIN LATERAL (
        SELECT *
        FROM participant_progress p
        WHERE p.user_id = u.id
        ORDER BY p.mission_created_at DESC
        LIMIT 1
      ) pp ON true
      ORDER BY u.created_at DESC
      LIMIT 12
    `);

    const [
      summaryResult,
      registeredNoMissionResult,
      waitingQueueResult,
      activeNoFirstCheckinResult,
      inactiveParticipantsResult,
      latestUsersResult
    ] = await Promise.all([
      summaryPromise,
      registeredNoMissionPromise,
      waitingQueuePromise,
      activeNoFirstCheckinPromise,
      inactiveParticipantsPromise,
      latestUsersPromise
    ]);

    const summary = summaryResult.rows[0];
    const startedCount = Number(summary.started_count || 0);
    const returnedCount = Number(summary.returned_next_day_count || 0);
    const nextDayRate = startedCount > 0 ? Math.round((returnedCount / startedCount) * 100) : 0;

    const latestUsers = latestUsersResult.rows.map(row => {
      let statusLabel = 'entrou agora';

      if (!row.title) {
        statusLabel = 'entrou mas ainda nao criou missao';
      } else if (row.status === 'waiting') {
        statusLabel = 'esta esperando match';
      } else if (row.status === 'completed') {
        statusLabel = 'concluiu a missao';
      } else if (Number(row.completed_checkins || 0) === 0) {
        statusLabel = 'criou a missao, mas ainda nao fez o primeiro check-in';
      } else if (Number(row.current_day || 0) - Number(row.last_checkin_day || 0) >= 2) {
        statusLabel = `sumiu ha ${Number(row.current_day || 0) - Number(row.last_checkin_day || 0)} dias`;
      } else {
        statusLabel = 'ativo no ciclo';
      }

      return {
        id: row.id,
        username: row.username,
        created_at: row.created_at,
        title: row.title,
        category: row.category,
        mode: row.mode,
        status_label: statusLabel
      };
    });

    res.json({
      summary: {
        total_users: Number(summary.total_users || 0),
        new_users_7d: Number(summary.new_users_7d || 0),
        total_participants: Number(summary.total_participants || 0),
        waiting_missions: Number(summary.waiting_missions || 0),
        active_missions: Number(summary.active_missions || 0),
        completed_missions: Number(summary.completed_missions || 0),
        checked_today: Number(summary.checked_today || 0),
        returned_next_day_rate: nextDayRate
      },
      blockers: {
        registered_no_mission: registeredNoMissionResult.rows,
        waiting_queue: waitingQueueResult.rows,
        active_no_first_checkin: activeNoFirstCheckinResult.rows,
        inactive_participants: inactiveParticipantsResult.rows
      },
      latest_users: latestUsers
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar insights.' });
  }
});

module.exports = router;
