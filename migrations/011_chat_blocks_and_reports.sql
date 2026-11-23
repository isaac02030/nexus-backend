-- Chat do Duo/Rival: bloquear e denunciar uma mensagem (decisão de 23/11).
-- Só acrescenta: duas tabelas novas, vazias. Nenhuma linha existente muda.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
--
-- user_blocks: quem bloqueou quem. Bloquear encerra o par (o código faz isso
-- nas missões, sem apagar ninguém) e este registro impede um novo par entre
-- os dois. Uma linha por dupla e sentido.
--
-- message_reports: denúncia de uma mensagem do chat. Guarda só o id da
-- mensagem (o texto continua na tabela messages, que sai com a conta de quem
-- escreveu), o motivo da lista curta e um comentário opcional de até 280
-- caracteres. Comentário com sinal de crise não chega aqui (o servidor o
-- descarta antes). Uma denúncia por pessoa por mensagem.
--
-- Dados pessoais: as duas tabelas saem junto com a conta (lib/account-deletion.js
-- apaga de forma explícita; ON DELETE CASCADE como segunda trava).
--
-- Para voltar atrás (apaga só bloqueios e denúncias do chat; os pares já
-- encerrados continuam encerrados):
--   DROP TABLE IF EXISTS message_reports;
--   DROP TABLE IF EXISTS user_blocks;
--   DELETE FROM schema_migrations WHERE version = '011_chat_blocks_and_reports';

BEGIN;

CREATE TABLE IF NOT EXISTS user_blocks (
  id SERIAL PRIMARY KEY,
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (blocker_id <> blocked_id),
  UNIQUE (blocker_id, blocked_id)
);

COMMENT ON TABLE user_blocks IS
  'Bloqueio no chat do Duo/Rival: encerra o par e impede um novo par entre as duas pessoas.';

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS message_reports (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(20) NOT NULL
    CHECK (reason IN ('perigoso', 'ofensa', 'improprio', 'spam', 'outro')),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 280),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, reporter_id)
);

COMMENT ON TABLE message_reports IS
  'Uma denúncia por pessoa por mensagem do chat. A equipe vê o trecho e o motivo, nunca quem denunciou.';

CREATE INDEX IF NOT EXISTS idx_message_reports_reporter
  ON message_reports(reporter_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('011_chat_blocks_and_reports')
ON CONFLICT (version) DO NOTHING;

COMMIT;
