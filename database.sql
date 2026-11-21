-- Safe database bootstrap for PostgreSQL installations.
-- The complete, idempotent schema is maintained as numbered migrations.
-- This file deliberately does not DROP tables or insert test users.
\ir migrations/001_initial_schema.sql
\ir migrations/002_user_reminder.sql
\ir migrations/003_checkin_difficult_day.sql
\ir migrations/004_mission_weekdays.sql
