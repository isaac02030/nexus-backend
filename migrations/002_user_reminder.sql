-- Daily reminder clock and IANA timezone chosen by each user.
-- Nullable on purpose: existing rows stay NULL and keep the old server-clock
-- reminder windows. Safe to run more than once: no DROP, no UPDATE of old data.
-- Sends are still deduped in notification_log (user, mission, kind, local day).

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reminder_time TIME,
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN users.reminder_time IS
  'Local time of the main daily reminder (HH:MM). NULL keeps the legacy server windows.';
COMMENT ON COLUMN users.timezone IS
  'IANA timezone for reminder_time, for example America/Sao_Paulo.';

INSERT INTO schema_migrations (version)
VALUES ('002_user_reminder')
ON CONFLICT (version) DO NOTHING;

COMMIT;
