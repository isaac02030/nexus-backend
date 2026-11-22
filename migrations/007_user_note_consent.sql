-- Consentimento para guardar a nota livre do check-in (decisão de 22/11).
-- A nota pode falar de saúde: só é gravada com um "sim" explícito e
-- separado. Guarda a ÚLTIMA escolha da pessoa:
--   note_consent         TRUE = sim, FALSE = não (ou retirou),
--                        NULL = ainda não respondeu (vale como "não").
--   note_consent_at      quando o servidor registrou a escolha.
--   note_consent_version versão do texto que a pessoa viu.
-- Nenhuma conta começa com "sim": o padrão é NULL (não guarda a nota).
-- Saem junto com a conta na exclusão (são colunas de users).
-- Só acrescenta. Safe to run more than once: no DROP, no UPDATE, no DELETE.
--
-- Para voltar atrás (apaga as escolhas; depois disso o check-in deixa de
-- guardar notas de todo mundo, e as rotas de consentimento respondem 503):
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_note_consent_complete;
--   ALTER TABLE users DROP COLUMN IF EXISTS note_consent_version;
--   ALTER TABLE users DROP COLUMN IF EXISTS note_consent_at;
--   ALTER TABLE users DROP COLUMN IF EXISTS note_consent;
--   DELETE FROM schema_migrations WHERE version = '007_user_note_consent';

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS note_consent BOOLEAN,
  ADD COLUMN IF NOT EXISTS note_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS note_consent_version VARCHAR(40);

-- Escolha sem data não existe: sim ou não vem sempre com a hora.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_note_consent_complete'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_note_consent_complete
      CHECK (note_consent IS NULL OR note_consent_at IS NOT NULL);
  END IF;
END
$$;

COMMENT ON COLUMN users.note_consent IS
  'Guardar a nota do check-in: TRUE = sim, FALSE = não ou retirou, NULL = ainda não respondeu (não guarda).';
COMMENT ON COLUMN users.note_consent_at IS
  'Quando o servidor registrou a última escolha sobre a nota.';
COMMENT ON COLUMN users.note_consent_version IS
  'Versão do texto do consentimento que a pessoa viu.';

INSERT INTO schema_migrations (version)
VALUES ('007_user_note_consent')
ON CONFLICT (version) DO NOTHING;

COMMIT;
