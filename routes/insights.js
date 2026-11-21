const express = require('express');
const { db } = require('../lib/db');
const auth = require('../middleware/auth');
const { ensureAdmin } = require('../lib/admin');
const {
  countMissionDays,
  missionDayContextFor,
  nextMissionDay,
  normalizeStoredWeekdays
} = require('../lib/mission-days');

const router = express.Router();
// Dias da missão nos insights.
// Missão sem dias escolhidos (NULL, ou a migração 004 ainda não aplicada):
// os números saem do SQL, como sempre. Com dias escolhidos, o "dia atual"
// usa o mesmo corte do check-in (routes/checkins.js: horário e fuso da
// pessoa) e os dias livres não contam como falta nem quebram a volta.

function hasChosenWeekdays(row) {
  return normalizeStoredWeekdays(row.mission_weekdays) !== null;
}

// Horário e fuso só de quem tem dias escolhidos. Sem ninguém assim, nenhuma
// consulta extra.
async function clocksFor(userIds) {
  const ids = [...new Set(userIds.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return new Map();
  const result = await db.query(
    `SELECT id, to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone
     FROM users
     WHERE id = ANY($1::int[])`,
    [ids]
  );
  return new Map(result.rows.map(row => [Number(row.id), row]));
}

function dayContextFor(row, clocks, now) {
  const clock = clocks.get(Number(row.user_id)) || {};
  return missionDayContextFor(row, clock.reminder_time, clock.timezone, now);
}

// Dia atual (entre 1 e a duração, como no SQL) e dias da missão sem
// check-in desde o último feito, contando hoje. Dia livre não conta.
function progressWithWeekdays(row, clocks, now) {
  const duration = Number(row.duration_days);
  const { dayNumber, isMissionDay } = dayContextFor(row, clocks, now);
  const today = Number.isInteger(dayNumber) ? dayNumber : 1;
  const currentDay = Math.min(Math.max(today, 1), duration);
  const lastDay = Math.min(Number(row.last_checkin_day || 0), currentDay);
  const missedDays = Math.max(
    0,
    countMissionDays(currentDay, isMissionDay) - countMissionDays(lastDay, isMissionDay)
  );
  return { currentDay, missedDays };
}

router.get('/overview', auth, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  try {
    const summaryPromise = db.query(`
      WITH mission_participants AS (
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
        (SELECT COUNT(DISTINCT user_id) FROM checkins WHERE completed = true AND created_at::date = CURRENT_DATE) AS checked_today
    `);

    // Quem começou (primeiro check-in) e se voltou no dia seguinte da missão.
    // Sem dias escolhidos, o dia seguinte é o Dia N + 1, como antes; com dias
    // escolhidos, é o próximo dia da missão (o dia livre no meio não quebra).
    // mission_weekdays via to_jsonb: NULL enquanto a migração 004 não existir.
    const firstCheckinsPromise = db.query(`
      WITH first_checkins AS (
        SELECT mission_id, user_id, MIN(day_number) AS first_day
        FROM checkins
        WHERE completed = true
        GROUP BY mission_id, user_id
      )
      SELECT
        f.mission_id,
        f.user_id,
        f.first_day,
        (
          SELECT MIN(c.day_number)
          FROM checkins c
          WHERE c.mission_id = f.mission_id
            AND c.user_id = f.user_id
            AND c.completed = true
            AND c.day_number > f.first_day
        ) AS next_done_day,
        m.started_at,
        m.duration_days,
        to_jsonb(m) -> 'mission_weekdays' AS mission_weekdays
      FROM first_checkins f
      LEFT JOIN missions m ON m.id = f.mission_id
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
          to_jsonb(m) -> 'mission_weekdays' AS mission_weekdays,
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
          to_jsonb(m) -> 'mission_weekdays' AS mission_weekdays,
          m.partner_id AS user_id,
          u2.username AS username
        FROM missions m
        JOIN users u2 ON u2.id = m.partner_id
        WHERE m.partner_id IS NOT NULL
      ),
      participant_progress AS (
        SELECT
          mp.mission_id,
          mp.user_id,
          mp.started_at,
          mp.duration_days,
          mp.mission_weekdays,
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
          mp.mission_id, mp.user_id, mp.title, mp.category, mp.mode, mp.status,
          mp.username, mp.mission_created_at, mp.started_at, mp.duration_days,
          mp.mission_weekdays
      )
      SELECT
        mission_id,
        user_id,
        title,
        category,
        mode,
        username,
        mission_created_at,
        started_at,
        duration_days,
        mission_weekdays,
        current_day,
        last_checkin_day,
        (current_day - last_checkin_day) AS missed_days
      FROM participant_progress
      -- Com dias escolhidos, a falta é recontada depois, sem os dias livres.
      WHERE (current_day - last_checkin_day) >= 2
         OR jsonb_typeof(mission_weekdays) = 'array'
      ORDER BY mission_created_at DESC
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
          m.duration_days,
          to_jsonb(m) -> 'mission_weekdays' AS mission_weekdays
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
          m.duration_days,
          to_jsonb(m) -> 'mission_weekdays' AS mission_weekdays
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
          mp.status, mp.mission_created_at, mp.started_at, mp.duration_days,
          mp.mission_weekdays
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
        pp.last_checkin_day,
        pp.started_at,
        pp.duration_days,
        pp.mission_weekdays
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
      firstCheckinsResult,
      registeredNoMissionResult,
      waitingQueueResult,
      activeNoFirstCheckinResult,
      inactiveParticipantsResult,
      latestUsersResult
    ] = await Promise.all([
      summaryPromise,
      firstCheckinsPromise,
      registeredNoMissionPromise,
      waitingQueuePromise,
      activeNoFirstCheckinPromise,
      inactiveParticipantsPromise,
      latestUsersPromise
    ]);

    const now = new Date();
    // latest_users: o id da pessoa vem em "id".
    const latestRows = latestUsersResult.rows.map(row => ({ ...row, user_id: row.id }));
    const clocks = await clocksFor([
      ...firstCheckinsResult.rows,
      ...inactiveParticipantsResult.rows,
      ...latestRows.filter(row => row.started_at)
    ].filter(hasChosenWeekdays).map(row => row.user_id));

    const summary = summaryResult.rows[0];
    const startedCount = firstCheckinsResult.rows.length;
    const returnedCount = firstCheckinsResult.rows.filter(row => {
      const firstDay = Number(row.first_day);
      const expected = hasChosenWeekdays(row)
        ? nextMissionDay(firstDay, row.duration_days, dayContextFor(row, clocks, now).isMissionDay)
        : firstDay + 1;
      return expected !== null && row.next_done_day != null && Number(row.next_done_day) === expected;
    }).length;
    const nextDayRate = startedCount > 0 ? Math.round((returnedCount / startedCount) * 100) : 0;

    const inactiveParticipants = inactiveParticipantsResult.rows
      .map(row => {
        let currentDay = row.current_day;
        let missedDays = row.missed_days;
        if (hasChosenWeekdays(row)) {
          ({ currentDay, missedDays } = progressWithWeekdays(row, clocks, now));
        }
        return {
          mission_id: row.mission_id,
          title: row.title,
          category: row.category,
          mode: row.mode,
          username: row.username,
          mission_created_at: row.mission_created_at,
          current_day: currentDay,
          last_checkin_day: row.last_checkin_day,
          missed_days: missedDays
        };
      })
      .filter(row => Number(row.missed_days) >= 2)
      .slice(0, 8);

    const latestUsers = latestRows.map(row => {
      let gapDays = Number(row.current_day || 0) - Number(row.last_checkin_day || 0);
      if (row.started_at && hasChosenWeekdays(row)) {
        gapDays = progressWithWeekdays(row, clocks, now).missedDays;
      }

      let statusLabel = 'entrou agora';

      if (!row.title) {
        statusLabel = 'entrou mas ainda nao criou missao';
      } else if (row.status === 'waiting') {
        statusLabel = 'esta esperando match';
      } else if (row.status === 'completed') {
        statusLabel = 'concluiu a missao';
      } else if (Number(row.completed_checkins || 0) === 0) {
        statusLabel = 'criou a missao, mas ainda nao fez o primeiro check-in';
      } else if (gapDays >= 2) {
        statusLabel = `sumiu ha ${gapDays} dias`;
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
        inactive_participants: inactiveParticipants
      },
      latest_users: latestUsers
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar insights.' });
  }
});

module.exports = router;
