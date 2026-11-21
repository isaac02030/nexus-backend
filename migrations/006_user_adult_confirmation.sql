-- Idade no cadastro: só maiores de 18.
-- Guarda o mínimo: a hora em que o servidor confirmou "maior de 18".
-- A data de nascimento NÃO é guardada (só serve para a conta no cadastro).
-- Só acrescenta: contas antigas ficam NULL ("ainda não confirmado") e
-- continuam funcionando como antes; ninguém é bloqueado por esta migração.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
--
-- Para voltar atrás (apaga o registro de quem confirmou a idade; depois
-- disso o cadastro novo responde 503 até a coluna voltar):
--   ALTER TABLE users DROP COLUMN IF EXISTS adult_confirmed_at;
--   DELETE FROM schema_migrations WHERE version = '006_user_adult_confirmation';

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS adult_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN users.adult_confirmed_at IS
  'Quando o servidor confirmou que a pessoa tem 18 anos ou mais. NULL = conta antiga, ainda não confirmada. A data de nascimento não é guardada.';

INSERT INTO schema_migrations (version)
VALUES ('006_user_adult_confirmation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
