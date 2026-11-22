-- Lembretes separados das novidades (decisão de 22/11).
-- Duas escolhas, cada uma com a hora do servidor e a versão do texto:
--   reminders_opt_in  lembretes da missão (motor de lembretes, Grande Irmão,
--                     aviso de check-in e de mensagem do par);
--   news_opt_in       novidades do Nexus (aviso para todos).
-- TRUE = sim, FALSE = não, NULL = ainda não escolheu (não manda nada).
-- Sem DEFAULT: nenhuma nasce ligada.
-- ATENÇÃO: depois desta migração, só recebe lembrete quem disser sim.
-- Saem junto com a conta na exclusão (são colunas de users).
-- Só acrescenta. Safe to run more than once: no DROP, no UPDATE, no DELETE.
--
-- Para voltar atrás (apaga as escolhas; os lembretes voltam a sair para
-- quem tem o push ligado, e as novidades ficam sem envio):
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_news_choice_complete;
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_reminders_choice_complete;
--   ALTER TABLE users DROP COLUMN IF EXISTS news_opt_in_version;
--   ALTER TABLE users DROP COLUMN IF EXISTS news_opt_in_at;
--   ALTER TABLE users DROP COLUMN IF EXISTS news_opt_in;
--   ALTER TABLE users DROP COLUMN IF EXISTS reminders_opt_in_version;
--   ALTER TABLE users DROP COLUMN IF EXISTS reminders_opt_in_at;
--   ALTER TABLE users DROP COLUMN IF EXISTS reminders_opt_in;
--   DELETE FROM schema_migrations WHERE version = '009_user_notification_choices';

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reminders_opt_in BOOLEAN,
  ADD COLUMN IF NOT EXISTS reminders_opt_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminders_opt_in_version VARCHAR(40),
  ADD COLUMN IF NOT EXISTS news_opt_in BOOLEAN,
  ADD COLUMN IF NOT EXISTS news_opt_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS news_opt_in_version VARCHAR(40);

-- Escolha sem data não existe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_reminders_choice_complete' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_reminders_choice_complete
      CHECK (reminders_opt_in IS NULL OR reminders_opt_in_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_news_choice_complete' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_news_choice_complete
      CHECK (news_opt_in IS NULL OR news_opt_in_at IS NOT NULL);
  END IF;
END
$$;

COMMENT ON COLUMN users.reminders_opt_in IS
  'Lembretes da missão por push: TRUE = sim, FALSE = não, NULL = ainda não escolheu (não envia).';
COMMENT ON COLUMN users.news_opt_in IS
  'Novidades do Nexus: TRUE = sim, FALSE = não, NULL = ainda não escolheu (não envia).';

INSERT INTO schema_migrations (version)
VALUES ('009_user_notification_choices')
ON CONFLICT (version) DO NOTHING;

COMMIT;
