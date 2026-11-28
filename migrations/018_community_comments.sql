-- Comentários nos posts da comunidade (item 4 do beta: comentários com
-- filtro de crise, denúncia, limite diário e apoio também no comentário).
-- Só acrescenta: três tabelas novas, vazias. Nenhuma linha existente muda.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
--
-- Um comentário é texto curto de uma pessoa num post (no máximo 280
-- caracteres reais, o mesmo limite da frase do check-in). Não há respostas
-- aninhadas: os comentários ficam em ordem de envio, dentro do post.
-- Antes de gravar, o servidor passa o texto pelo filtro de crise: com crise,
-- nada é salvo nem escrito em log e a pessoa vê a ajuda.
--
-- Cada pessoa comenta no máximo 10 vezes em 24 horas, somando comunidades
-- (o limite é de aplicação, em routes/communities.js; o banco só guarda as
-- linhas). A cota é contada na leitura, sem coluna contadora.
--
-- Denúncia: uma por pessoa por comentário (UNIQUE). Com 3 pessoas diferentes
-- o comentário fica escondido; o motivo "perigoso" esconde na 1.ª denúncia,
-- até 3 por pessoa em 24 horas. Esconder não apaga: a equipe confere depois.
--
-- Apoio: 1 por pessoa por comentário (UNIQUE). Só o total aparece; ninguém
-- vê quem apoiou. Apoiar não dá moeda nem ponto.
--
-- Dados pessoais: quem escreveu, denunciou ou apoiou. Saem com a conta
-- (lib/account-deletion.js apaga de forma explícita; ON DELETE CASCADE como
-- segunda trava), com o comentário e com o post.
--
-- Para voltar atrás (perde só comentários, denúncias e apoios; os posts ficam):
--   DROP TABLE IF EXISTS community_comment_supports;
--   DROP TABLE IF EXISTS community_comment_reports;
--   DROP TABLE IF EXISTS community_comments;
--   DELETE FROM schema_migrations WHERE version = '018_community_comments';

BEGIN;

CREATE TABLE IF NOT EXISTS community_comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 280),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hidden_at TIMESTAMPTZ,
  hidden_reason VARCHAR(20) CHECK (hidden_reason IN ('perigoso', 'ofensa', 'improprio', 'spam', 'outro')),
  restored_at TIMESTAMPTZ
);

COMMENT ON TABLE community_comments IS
  'Comentário num post da comunidade: texto curto, sem respostas aninhadas.';

CREATE TABLE IF NOT EXISTS community_comment_reports (
  id SERIAL PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(20) NOT NULL
    CHECK (reason IN ('perigoso', 'ofensa', 'improprio', 'spam', 'outro')),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 280),
  fast_track BOOLEAN NOT NULL DEFAULT FALSE,
  hid_comment_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (comment_id, reporter_id)
);

COMMENT ON TABLE community_comment_reports IS
  'Denúncia de comentário: 1 por pessoa, esconde com 3 pessoas ou 1 perigoso.';

CREATE TABLE IF NOT EXISTS community_comment_supports (
  id SERIAL PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (comment_id, user_id)
);

COMMENT ON TABLE community_comment_supports IS
  'Apoio a comentário: 1 por pessoa; só o total é mostrado.';

CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_community_comments_user ON community_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_community_comment_reports_comment ON community_comment_reports(comment_id);
CREATE INDEX IF NOT EXISTS idx_community_comment_reports_reporter ON community_comment_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_community_comment_supports_comment ON community_comment_supports(comment_id);
CREATE INDEX IF NOT EXISTS idx_community_comment_supports_user ON community_comment_supports(user_id);

INSERT INTO schema_migrations (version)
VALUES ('018_community_comments')
ON CONFLICT (version) DO NOTHING;

COMMIT;
