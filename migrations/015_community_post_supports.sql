-- Apoios nos posts da comunidade (PR C da comunidade, plano do Vitrúvio).
-- Só acrescenta: uma tabela nova, vazia, e um índice para a lista por
-- cursor. Nenhuma linha existente muda.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
--
-- Um apoio = uma pessoa + um post, no máximo 1 (UNIQUE). O total é contado
-- na leitura (sem coluna contadora, sem corrida). Ninguém vê a lista de quem
-- apoiou: as rotas só devolvem o total e se a própria pessoa apoiou.
-- Os destaques da semana são calculados na leitura (apoios dos últimos 7
-- dias), sem tabela. Apoiar não dá moeda nem ponto.
--
-- Dados pessoais: quem apoiou. Saem com a conta (lib/account-deletion.js
-- apaga de forma explícita; ON DELETE CASCADE como segunda trava) e com o
-- post.
--
-- Para voltar atrás (perde só os apoios; os posts ficam):
--   DROP TABLE IF EXISTS community_post_supports;
--   DROP INDEX IF EXISTS idx_community_posts_feed;
--   DELETE FROM schema_migrations WHERE version = '015_community_post_supports';

BEGIN;

CREATE TABLE IF NOT EXISTS community_post_supports (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, user_id)
);

COMMENT ON TABLE community_post_supports IS
  'Apoio a um post da comunidade: 1 por pessoa por post; só o total é mostrado.';

CREATE INDEX IF NOT EXISTS idx_community_post_supports_user ON community_post_supports(user_id);
CREATE INDEX IF NOT EXISTS idx_community_post_supports_recent ON community_post_supports(post_id, created_at);
-- Lista de posts por cursor (created_at, id), do mais novo ao mais antigo.
CREATE INDEX IF NOT EXISTS idx_community_posts_feed ON community_posts(community_id, created_at DESC, id DESC);

INSERT INTO schema_migrations (version)
VALUES ('015_community_post_supports')
ON CONFLICT (version) DO NOTHING;

COMMIT;
