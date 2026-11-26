-- Convite por link para o Duo e o Rival (decisão de 26/11, itens 1 e 3).
-- Só acrescenta: uma tabela nova, vazia. Nenhuma linha existente muda.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
--
-- Um convite = uma missão Solo do dono + o tipo (duo ou rival) + o HASH
-- (sha256) de um token aleatório forte. O token em si nunca é guardado: só
-- quem recebeu o link o tem. Uso único (used_at), vale 7 dias (expires_at,
-- com o relógio do banco) e o dono pode cancelar (canceled_at).
--
-- Dados pessoais: quem criou e quem usou. Saem com a conta
-- (lib/account-deletion.js apaga de forma explícita; ON DELETE como segunda
-- trava). Convites da missão saem com a missão.
--
-- Para voltar atrás (apaga só os convites; os pares já formados continuam):
--   DROP TABLE IF EXISTS mission_invites;
--   DELETE FROM schema_migrations WHERE version = '012_mission_invites';

BEGIN;

CREATE TABLE IF NOT EXISTS mission_invites (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('duo', 'rival')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  canceled_at TIMESTAMPTZ,
  CHECK (used_at IS NULL OR canceled_at IS NULL)
);

COMMENT ON TABLE mission_invites IS
  'Convite por link (Duo ou Rival): só o hash do token, uso único, 7 dias, cancelável pelo dono.';

CREATE INDEX IF NOT EXISTS idx_mission_invites_mission ON mission_invites(mission_id);
CREATE INDEX IF NOT EXISTS idx_mission_invites_used_by ON mission_invites(used_by);

INSERT INTO schema_migrations (version)
VALUES ('012_mission_invites')
ON CONFLICT (version) DO NOTHING;

COMMIT;
