-- Duo invites. The raw code is never stored: code_hash is the SHA-256 of a
-- random single-use code. Safe to re-run. No DROP and no data replacement.
BEGIN;

CREATE TABLE IF NOT EXISTS mission_invites (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'declined')),
  expires_at TIMESTAMP NOT NULL,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at TIMESTAMP,
  declined_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mission_invites_mission ON mission_invites(mission_id);
CREATE INDEX IF NOT EXISTS idx_mission_invites_pending ON mission_invites(mission_id, expires_at) WHERE status = 'pending';

INSERT INTO schema_migrations (version)
VALUES ('002_mission_invites')
ON CONFLICT (version) DO NOTHING;

COMMIT;
