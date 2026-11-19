-- Safe database bootstrap for PostgreSQL installations.
-- The complete, idempotent schema is maintained as numbered migrations.
-- This file deliberately does not DROP tables or insert test users.
\ir migrations/001_initial_schema.sql
\ir migrations/002_mission_invites.sql
