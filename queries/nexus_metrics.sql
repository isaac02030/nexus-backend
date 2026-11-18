-- Run this query on a PostgreSQL database with the current Nexus schema.
-- Mission completion excludes missions that never left the waiting queue.
-- Return-after-failure means a user has a completed check-in after a missed day.
-- Waiting time uses created_at -> match_started_at for paired missions, and
-- created_at -> started_at for legacy paired missions; older deleted queue rows
-- cannot be measured retrospectively.
WITH mission_population AS (
  SELECT id, user_id, partner_id, mode, status, created_at, started_at, duration_days
  FROM missions
  WHERE merged_into_id IS NULL
),
mission_completion AS (
  SELECT
    COUNT(*) FILTER (WHERE status IN ('active', 'completed', 'abandoned')) AS started,
    COUNT(*) FILTER (WHERE status = 'completed') AS completed
  FROM mission_population
),
participant_missions AS (
  SELECT m.id AS mission_id, m.user_id, m.status, m.started_at, m.duration_days
  FROM mission_population m
  UNION ALL
  SELECT m.id AS mission_id, m.partner_id AS user_id, m.status, m.started_at, m.duration_days
  FROM mission_population m
  WHERE m.partner_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM mission_matches mm
      WHERE mm.mission_a_id = m.id OR mm.mission_b_id = m.id
    )
),
participant_days AS (
  SELECT
    m.mission_id,
    m.user_id,
    m.started_at::date AS start_date,
    CASE WHEN m.status = 'completed' THEN m.duration_days
         ELSE LEAST(m.duration_days, GREATEST(0, CURRENT_DATE - m.started_at::date))
    END AS observed_days,
    ARRAY_AGG(DISTINCT c.day_number) FILTER (WHERE c.completed) AS completed_days
  FROM participant_missions m
  LEFT JOIN checkins c ON c.mission_id = m.mission_id AND c.user_id = m.user_id
  WHERE m.started_at IS NOT NULL
  GROUP BY m.mission_id, m.user_id, m.status, m.started_at, m.duration_days
),
first_failure AS (
  SELECT p.*,
         MIN(d.day_number) FILTER (
           WHERE NOT (d.day_number = ANY(COALESCE(p.completed_days, ARRAY[]::integer[])))
         ) AS first_missed_day
  FROM participant_days p
  CROSS JOIN LATERAL generate_series(1, p.observed_days) AS d(day_number)
  GROUP BY p.mission_id, p.user_id, p.start_date, p.observed_days, p.completed_days
),
recovery_metrics AS (
  SELECT
    COUNT(DISTINCT user_id) FILTER (WHERE first_missed_day IS NOT NULL) AS users_with_first_failure,
    COUNT(DISTINCT user_id) FILTER (
      WHERE first_missed_day IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM unnest(COALESCE(completed_days, ARRAY[]::integer[])) AS later_day(day_number)
          WHERE later_day.day_number > first_missed_day
        )
    ) AS users_returned_after_failure
  FROM first_failure
),
second_mission AS (
  SELECT
    COUNT(*) AS users_with_missions,
    COUNT(*) FILTER (WHERE mission_count >= 2) AS users_with_second_mission
  FROM (
    SELECT user_id, COUNT(*) AS mission_count
    FROM mission_population
    GROUP BY user_id
  ) counts
),
waiting_metrics AS (
  SELECT
    COUNT(*) AS missions_that_started,
    AVG(wait_duration) AS average_wait,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_duration) AS median_wait
  FROM (
    SELECT m.id,
           GREATEST(INTERVAL '0 seconds', mm.started_at - m.created_at) AS wait_duration
    FROM mission_matches mm
    JOIN mission_population m ON m.id = mm.mission_a_id
    WHERE mm.status IN ('active', 'ended')
    UNION ALL
    SELECT m.id,
           GREATEST(INTERVAL '0 seconds', mm.started_at - m.created_at) AS wait_duration
    FROM mission_matches mm
    JOIN mission_population m ON m.id = mm.mission_b_id
    WHERE mm.status IN ('active', 'ended')
    UNION ALL
    SELECT m.id,
           GREATEST(INTERVAL '0 seconds', m.started_at - m.created_at) AS wait_duration
    FROM mission_population m
    WHERE m.started_at IS NOT NULL
      AND m.mode IN ('parceiro', 'rival')
      AND NOT EXISTS (
        SELECT 1 FROM mission_matches mm
        WHERE mm.mission_a_id = m.id OR mm.mission_b_id = m.id
      )
  ) measured_waits
)
SELECT metric, value, detail
FROM (
  SELECT 'mission_completion_rate' AS metric,
         CASE WHEN started = 0 THEN NULL ELSE ROUND(100.0 * completed / started, 2) END AS value,
         format('%s completed / %s started', completed, started) AS detail
  FROM mission_completion
  UNION ALL
  SELECT 'return_after_first_failure_rate',
         CASE WHEN users_with_first_failure = 0 THEN NULL
              ELSE ROUND(100.0 * users_returned_after_failure / users_with_first_failure, 2) END,
         format('%s returned / %s with first failure', users_returned_after_failure, users_with_first_failure)
  FROM recovery_metrics
  UNION ALL
  SELECT 'users_starting_second_mission',
         CASE WHEN users_with_missions = 0 THEN NULL
              ELSE ROUND(100.0 * users_with_second_mission / users_with_missions, 2) END,
         format('%s of %s users have 2+ missions', users_with_second_mission, users_with_missions)
  FROM second_mission
  UNION ALL
  SELECT 'time_in_waiting_minutes',
         ROUND(EXTRACT(EPOCH FROM average_wait)::numeric / 60, 2),
         format('median %s minutes; based on %s started paired missions',
                ROUND(EXTRACT(EPOCH FROM median_wait)::numeric / 60, 2), missions_that_started)
  FROM waiting_metrics
) metrics
ORDER BY metric;
