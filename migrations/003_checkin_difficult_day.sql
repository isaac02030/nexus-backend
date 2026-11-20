-- Marks a completed check-in as one of the four difficult days for that person.
-- The daily minimum still counts as done. Existing rows stay false.
-- Safe to run more than once: no DROP and no rewrite of old notes.

BEGIN;

ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS is_difficult BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN checkins.is_difficult IS
  'True when this person used one of their four difficult days. The day still counts as completed.';

INSERT INTO schema_migrations (version)
VALUES ('003_checkin_difficult_day')
ON CONFLICT (version) DO NOTHING;

COMMIT;
