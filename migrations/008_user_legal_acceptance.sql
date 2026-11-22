-- Aceite dos Termos de uso e da Política de privacidade (decisão de 22/11).
-- Guarda o ÚLTIMO aceite de cada texto: a versão aceita e a hora do
-- servidor. Sem DEFAULT: ninguém fica com aceite que não deu.
-- Contas sem registro ficam NULL e o servidor pede o aceite (needs_acceptance).
-- Saem junto com a conta na exclusão (são colunas de users).
-- Só acrescenta. Safe to run more than once: no DROP, no UPDATE, no DELETE.
--
-- Antes desta migração, o cadastro responde 503 calmo e não cria conta
-- (o INSERT pede estas colunas): nenhuma conta nasce sem o aceite guardado.
--
-- Para voltar atrás (apaga os registros de aceite; depois disso o cadastro
-- volta a responder 503 até as colunas voltarem):
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_privacy_acceptance_complete;
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_terms_acceptance_complete;
--   ALTER TABLE users DROP COLUMN IF EXISTS privacy_accepted_at;
--   ALTER TABLE users DROP COLUMN IF EXISTS privacy_version;
--   ALTER TABLE users DROP COLUMN IF EXISTS terms_accepted_at;
--   ALTER TABLE users DROP COLUMN IF EXISTS terms_version;
--   DELETE FROM schema_migrations WHERE version = '008_user_legal_acceptance';

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_version VARCHAR(40),
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_version VARCHAR(40),
  ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;

-- Versão e hora andam juntas: as duas ou nenhuma.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_terms_acceptance_complete' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_terms_acceptance_complete
      CHECK ((terms_version IS NULL) = (terms_accepted_at IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_privacy_acceptance_complete' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_privacy_acceptance_complete
      CHECK ((privacy_version IS NULL) = (privacy_accepted_at IS NULL));
  END IF;
END
$$;

COMMENT ON COLUMN users.terms_version IS
  'Versão dos Termos de uso aceita por último. NULL = sem registro de aceite.';
COMMENT ON COLUMN users.terms_accepted_at IS
  'Quando o servidor registrou o aceite dos Termos de uso.';
COMMENT ON COLUMN users.privacy_version IS
  'Versão da Política de privacidade aceita por último. NULL = sem registro de aceite.';
COMMENT ON COLUMN users.privacy_accepted_at IS
  'Quando o servidor registrou o aceite da Política de privacidade.';

INSERT INTO schema_migrations (version)
VALUES ('008_user_legal_acceptance')
ON CONFLICT (version) DO NOTHING;

COMMIT;
