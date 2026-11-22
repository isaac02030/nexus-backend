-- ============================================
-- NEXUS — Usuário do app sem poder de dono
--
-- NÃO é migração: não roda sozinho e não entra em migrations/.
-- Roda à mão, uma vez por banco (e de novo depois de cada migração nova
-- ou de uma restauração), com o usuário das MIGRAÇÕES (dono das tabelas):
--
--   psql "<endereço do usuário das migrações>" -v ON_ERROR_STOP=1 -f scripts/sql/papel-do-app.sql
--
-- Depois, ainda no psql desse usuário, ponha a senha do app (o psql
-- pergunta; a senha não fica em arquivo nem no histórico):
--
--   \password nexus_app
--
-- O que o nexus_app pode: ler e gravar linhas (SELECT, INSERT, UPDATE,
-- DELETE) nas tabelas do esquema public e usar as sequências (ids).
-- O que NÃO pode: criar, alterar ou apagar tabelas (DDL), criar tabela
-- temporária, criar papéis ou bancos, escrever na tabela de migrações.
-- Explicação: docs/banco-seguranca.md
-- ============================================

\set ON_ERROR_STOP on

BEGIN;

-- 1. Cria o papel se ainda não existir. Sem senha aqui (ver \password acima).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    CREATE ROLE nexus_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- 2. Se o papel já existia com algum poder a mais, para tudo e avisa.
DO $$
DECLARE r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'nexus_app';
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'O papel nexus_app tem poderes a mais (superuser, createdb, createrole, replication ou bypassrls). Tire esses poderes antes de seguir.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
             WHERE m.member = r.oid) THEN
    RAISE EXCEPTION 'O papel nexus_app é membro de outro papel e pode herdar poderes. Revise com \du nexus_app.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'nexus_app') THEN
    RAISE EXCEPTION 'O nexus_app é dono de alguma tabela. As tabelas devem ser do usuário das migrações.';
  END IF;
END
$$;

-- 3. Pode conectar neste banco e enxergar o esquema public, sem criar nada nele.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nexus_app', current_database());
  -- Tabela temporária também é criação: ninguém além do dono cria aqui.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM nexus_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO nexus_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM nexus_app;

-- 4. Linhas: ler e gravar em todas as tabelas que já existem.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexus_app;
-- Sequências: só o necessário para gerar ids (nextval).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_app;

-- 5. A tabela de migrações é do usuário das migrações: o app só lê.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE ALL ON public.schema_migrations FROM nexus_app;
    GRANT SELECT ON public.schema_migrations TO nexus_app;
  END IF;
END
$$;

-- 6. Tabelas e sequências criadas no futuro POR ESTE usuário (o das
--    migrações) já nascem com as mesmas permissões para o app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexus_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nexus_app;

COMMIT;

-- Conferência (só leitura): o que o nexus_app pode em cada tabela.
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS pode
FROM information_schema.role_table_grants
WHERE grantee = 'nexus_app'
GROUP BY table_name
ORDER BY table_name;
