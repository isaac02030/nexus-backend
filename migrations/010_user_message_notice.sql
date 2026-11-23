-- Aviso de mensagem nova do chat do Duo/Rival (decisão de 23/11).
-- Uma escolha própria, separada dos lembretes e das novidades, com a hora do
-- servidor e a versão do texto (mesmo padrão da 009):
--   message_notice_opt_in  TRUE = sim, FALSE = não, NULL = ainda não escolheu
--                          (não manda nada). Sem DEFAULT: nasce desligado.
-- O aviso tem texto fixo («Você tem uma mensagem nova.»), sem nome nem trecho,
-- e sai no máximo 1 vez por dia por conversa (notification_log, kind 'chat').
-- Saem junto com a conta na exclusão (são colunas de users).
-- Só acrescenta. Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
--
-- Para voltar atrás (apaga só esta escolha; nenhum aviso de mensagem sai):
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_message_notice_choice_complete;
--   ALTER TABLE users DROP COLUMN IF EXISTS message_notice_opt_in_version;
--   ALTER TABLE users DROP COLUMN IF EXISTS message_notice_opt_in_at;
--   ALTER TABLE users DROP COLUMN IF EXISTS message_notice_opt_in;
--   DELETE FROM schema_migrations WHERE version = '010_user_message_notice';

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS message_notice_opt_in BOOLEAN,
  ADD COLUMN IF NOT EXISTS message_notice_opt_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS message_notice_opt_in_version VARCHAR(40);

-- Escolha sem data não existe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_message_notice_choice_complete' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_message_notice_choice_complete
      CHECK (message_notice_opt_in IS NULL OR message_notice_opt_in_at IS NOT NULL);
  END IF;
END
$$;

COMMENT ON COLUMN users.message_notice_opt_in IS
  'Aviso de mensagem nova do chat por push: TRUE = sim, FALSE = não, NULL = ainda não escolheu (não envia).';

INSERT INTO schema_migrations (version)
VALUES ('010_user_message_notice')
ON CONFLICT (version) DO NOTHING;

COMMIT;
