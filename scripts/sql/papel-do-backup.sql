-- ============================================
-- NEXUS — Usuário só de leitura para o backup automático
--
-- NÃO é migração. Roda à mão, com o usuário das MIGRAÇÕES, uma vez por
-- banco (e de novo depois de migração nova ou restauração):
--
--   psql "<endereço do usuário das migrações>" -v ON_ERROR_STOP=1 -f scripts/sql/papel-do-backup.sql
--   \password nexus_backup
--
-- O nexus_backup só LÊ (o pg_dump precisa só disso). Não grava, não
-- apaga, não cria nada. Se o endereço dele vazar, ninguém muda o banco
-- com ele (mas lê tudo: guarde como segredo). Ver docs/backup.md.
-- ============================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_backup') THEN
    CREATE ROLE nexus_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

DO $$
DECLARE r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'nexus_backup';
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'O papel nexus_backup tem poderes a mais. Tire esses poderes antes de seguir.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) THEN
    RAISE EXCEPTION 'O papel nexus_backup é membro de outro papel e pode herdar poderes. Revise com \du nexus_backup.';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nexus_backup', current_database());
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM nexus_backup', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO nexus_backup;
REVOKE CREATE ON SCHEMA public FROM nexus_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nexus_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nexus_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO nexus_backup;

COMMIT;
