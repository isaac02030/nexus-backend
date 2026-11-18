-- Safe database bootstrap for PostgreSQL installations.
-- The complete, idempotent schema is maintained as a numbered migration.
-- This file deliberately does not DROP tables or insert test users.
\ir migrations/001_initial_schema.sql
