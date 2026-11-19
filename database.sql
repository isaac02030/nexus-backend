-- Safe database bootstrap for PostgreSQL installations.
-- The complete, idempotent schema is maintained as numbered migrations.
-- This file deliberately does not DROP tables or insert test users.
-- 002_user_reminder.sql and 003_checkin_difficult_day.sql belong to other
-- open pull requests. This branch applies 001, then 004. 004 only needs the
-- tables from 001.
\ir migrations/001_initial_schema.sql
\ir migrations/004_mission_invites.sql
