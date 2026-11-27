-- Áreas da comunidade (decisões de 26/11: comunidades por áreas, sem IA;
-- e de 27/11: começar pelo PR A).
-- Só acrescenta colunas que começam vazias (NULL). Nenhuma linha existente
-- muda: missões e comunidades antigas ficam sem área.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
--
-- missions.area: mente, corpo ou rotina (lista fixa). NULL = missão antiga,
--   sem área: lê a comunidade, mas não posta.
-- missions.subject: assunto curto escrito pela pessoa (ex.: psicologia), até
--   60 caracteres. Serve só para ordenar as comunidades recomendadas, por
--   palavra, sem IA. É texto da pessoa: na exclusão de conta sai com a missão
--   ou vira NULL quando a missão passa ao parceiro do Duo.
-- communities.area: a área da comunidade. NULL = ainda sem área: ninguém
--   posta até ela ter uma (as 8 prontas chegam com área na migração 014).
--
-- Para voltar atrás (perde só o que foi gravado nestas colunas):
--   ALTER TABLE missions DROP COLUMN IF EXISTS subject;
--   ALTER TABLE missions DROP COLUMN IF EXISTS area;
--   ALTER TABLE communities DROP COLUMN IF EXISTS area;
--   DELETE FROM schema_migrations WHERE version = '013_community_areas';

BEGIN;

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS area VARCHAR(10)
    CONSTRAINT missions_area_check CHECK (area IN ('mente', 'corpo', 'rotina')),
  ADD COLUMN IF NOT EXISTS subject VARCHAR(60);

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS area VARCHAR(10)
    CONSTRAINT communities_area_check CHECK (area IN ('mente', 'corpo', 'rotina'));

COMMENT ON COLUMN missions.area IS 'Área da missão: mente, corpo ou rotina. NULL em missão antiga.';
COMMENT ON COLUMN missions.subject IS 'Assunto curto escrito pela pessoa, só para recomendar comunidades por palavra.';
COMMENT ON COLUMN communities.area IS 'Área da comunidade: mente, corpo ou rotina. Postar pede missão ativa desta área.';

-- Postar usa os índices que já existem em missions(user_id) e (partner_id).
-- Recomendar: as comunidades de uma área.
CREATE INDEX IF NOT EXISTS idx_communities_area ON communities(area);

INSERT INTO schema_migrations (version)
VALUES ('013_community_areas')
ON CONFLICT (version) DO NOTHING;

COMMIT;
