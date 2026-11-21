-- Denúncia de posts da comunidade e post escondido até o admin conferir.
-- Só acrescenta: uma tabela nova e três colunas novas, vazias (NULL), em
-- community_posts. Nenhum post muda: todos continuam visíveis.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
--
-- Dados pessoais: community_post_reports.details é um comentário opcional
-- de quem denunciou (até 280 caracteres). Comentário com sinal de crise não
-- chega aqui (o servidor o descarta antes). Ao apagar o post ou a conta de
-- quem denunciou, as denúncias saem junto (ON DELETE CASCADE).
--
-- Para voltar atrás (apaga as denúncias e o estado "escondido"; os posts
-- escondidos voltam a aparecer):
--   DROP TABLE IF EXISTS community_post_reports;
--   ALTER TABLE community_posts DROP COLUMN IF EXISTS hidden_at;
--   ALTER TABLE community_posts DROP COLUMN IF EXISTS hidden_reason;
--   ALTER TABLE community_posts DROP COLUMN IF EXISTS restored_at;
--   DELETE FROM schema_migrations WHERE version = '005_community_post_reports';

BEGIN;

ALTER TABLE community_posts
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hidden_reason VARCHAR(20),
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;

COMMENT ON COLUMN community_posts.hidden_at IS
  'Quando o post foi escondido por denúncias. NULL = visível. Não apaga o post.';
COMMENT ON COLUMN community_posts.hidden_reason IS
  'Motivo mais citado nas denúncias quando o post foi escondido (o autor vê).';
COMMENT ON COLUMN community_posts.restored_at IS
  'Última vez que o admin restaurou o post. Só contam denúncias depois disso.';

CREATE TABLE IF NOT EXISTS community_post_reports (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(20) NOT NULL
    CHECK (reason IN ('perigoso', 'ofensa', 'improprio', 'spam', 'outro')),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 280),
  -- true = denúncia "perigoso" que esconde sozinha. Cada pessoa tem no
  -- máximo 3 dessas a cada 24 horas; a partir da 4.ª, fica false e conta
  -- como denúncia comum (entra nas 3 pessoas).
  fast_track BOOLEAN NOT NULL DEFAULT FALSE,
  -- Quando o post foi escondido com esta denúncia contando. Serve ao alerta
  -- do admin "a mesma pessoa escondeu 2 ou mais posts em 24 horas".
  hid_post_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, reporter_id)
);

COMMENT ON TABLE community_post_reports IS
  'Uma denúncia por pessoa por post. Com 3 pessoas diferentes, ou 1 com o motivo perigoso, o post fica escondido.';

CREATE INDEX IF NOT EXISTS idx_community_post_reports_reporter
  ON community_post_reports(reporter_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_posts_hidden
  ON community_posts(hidden_at) WHERE hidden_at IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('005_community_post_reports')
ON CONFLICT (version) DO NOTHING;

COMMIT;
