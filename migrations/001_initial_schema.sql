-- Nexus initial schema, reconciled from the tables and columns referenced by
-- the current backend routes. Safe for existing installations: no DROP or
-- data replacement statements are used.
BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS missions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT,
  daily_minimum VARCHAR(120),
  commitment_window VARCHAR(120),
  why_it_matters TEXT,
  fallback_plan TEXT,
  proof_mode VARCHAR(40) DEFAULT 'self_report',
  study_focus VARCHAR(160),
  study_current_stage VARCHAR(160),
  study_target_outcome TEXT,
  level VARCHAR(20) DEFAULT 'iniciante',
  mode VARCHAR(20) DEFAULT 'solo',
  match_preference VARCHAR(20),
  duration_days INTEGER NOT NULL DEFAULT 30,
  user_score INTEGER NOT NULL DEFAULT 0,
  partner_score INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  started_at TIMESTAMP,
  partner_started_at TIMESTAMP,
  pair_started_at TIMESTAMP,
  ends_at TIMESTAMP,
  merged_into_id INTEGER REFERENCES missions(id) ON DELETE SET NULL,
  user_contact TEXT,
  partner_contact TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS daily_minimum VARCHAR(120),
  ADD COLUMN IF NOT EXISTS commitment_window VARCHAR(120),
  ADD COLUMN IF NOT EXISTS why_it_matters TEXT,
  ADD COLUMN IF NOT EXISTS fallback_plan TEXT,
  ADD COLUMN IF NOT EXISTS proof_mode VARCHAR(40) DEFAULT 'self_report',
  ADD COLUMN IF NOT EXISTS study_focus VARCHAR(160),
  ADD COLUMN IF NOT EXISTS study_current_stage VARCHAR(160),
  ADD COLUMN IF NOT EXISTS study_target_outcome TEXT,
  ADD COLUMN IF NOT EXISTS match_preference VARCHAR(20),
  ADD COLUMN IF NOT EXISTS partner_started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS pair_started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES missions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS user_contact TEXT,
  ADD COLUMN IF NOT EXISTS partner_contact TEXT;

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
);

CREATE TABLE IF NOT EXISTS checkins (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (mission_id, user_id, day_number)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS communities (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(140) NOT NULL UNIQUE,
  description TEXT,
  category VARCHAR(100) NOT NULL,
  icon VARCHAR(40),
  cover_color VARCHAR(32),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_members (
  id SERIAL PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank VARCHAR(40) NOT NULL DEFAULT 'recruta',
  missions_done INTEGER NOT NULL DEFAULT 0,
  total_days INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_posts (
  id SERIAL PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_missions (
  id SERIAL PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  mode VARCHAR(30) NOT NULL,
  scope VARCHAR(30) NOT NULL DEFAULT 'mundial',
  duration_days INTEGER NOT NULL DEFAULT 30,
  max_participants INTEGER NOT NULL DEFAULT 100,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  starts_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_mission_participants (
  id SERIAL PRIMARY KEY,
  community_mission_id INTEGER NOT NULL REFERENCES community_missions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (community_mission_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, endpoint)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  kind VARCHAR(40) NOT NULL,
  sent_on DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, mission_id, kind, sent_on)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_missions_user ON missions(user_id);
CREATE INDEX IF NOT EXISTS idx_missions_partner ON missions(partner_id);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
CREATE INDEX IF NOT EXISTS idx_missions_match_pool ON missions(status, category, match_preference, level);
CREATE INDEX IF NOT EXISTS idx_mission_matches_active_a ON mission_matches(mission_a_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_mission_matches_active_b ON mission_matches(mission_b_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_checkins_mission ON checkins(mission_id);
CREATE INDEX IF NOT EXISTS idx_checkins_user_mission ON checkins(user_id, mission_id, day_number);
CREATE INDEX IF NOT EXISTS idx_messages_mission ON messages(mission_id);
CREATE INDEX IF NOT EXISTS idx_community_posts_recent ON community_posts(community_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('001_initial_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
