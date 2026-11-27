-- As 8 comunidades prontas, já com área (decisão de 26/11: comunidades por
-- áreas, sem IA; ordem do Vitrúvio de 27/11, PR B).
-- ALTERA DADOS: insere 8 linhas novas. Nenhuma linha existente é tocada:
-- se um slug já existe, aquela linha fica como está (ON CONFLICT DO NOTHING).
-- Safe to run more than once: rodar de novo não duplica nada.
-- Precisa da 013 (coluna communities.area); sem ela, falha inteira e nada entra.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
--
-- Antes de aplicar, conferir se algum slug já existe (essa comunidade não
-- ganharia área e ninguém posta nela):
--   SELECT slug, area FROM communities WHERE slug IN ('estudos', 'idiomas',
--     'leitura', 'academia', 'corrida', 'alimentacao', 'organizacao', 'sono');
--
-- Sem autor (created_by NULL) e is_default = true. Os textos são para o sim
-- do dono do projeto; as regras da Alimentação passam pela Lanterna.
--
-- Para voltar atrás (só se ainda não houver posts nelas: posts, membros e
-- missões de comunidade saem junto, em cascata):
--   DELETE FROM communities
--   WHERE is_default = true AND created_by IS NULL
--     AND slug IN ('estudos', 'idiomas', 'leitura', 'academia', 'corrida',
--                  'alimentacao', 'organizacao', 'sono');
--   DELETE FROM schema_migrations WHERE version = '014_default_communities';

BEGIN;

INSERT INTO communities (name, slug, description, category, area, is_default, created_by, member_count)
VALUES
  ('Estudos', 'estudos', 'Para quem estuda todo dia: provas, cursos e concursos. Troque métodos e conte como foi a sessão.', 'estudos', 'mente', true, NULL, 0),
  ('Idiomas', 'idiomas', 'Inglês, espanhol ou outra língua. Compartilhe o que funciona para praticar um pouco por dia.', 'idiomas', 'mente', true, NULL, 0),
  ('Leitura', 'leitura', 'Livros, páginas por dia e o que você está lendo agora.', 'leitura', 'mente', true, NULL, 0),
  ('Academia', 'academia', 'Treino de força e rotina na academia. Dúvidas de iniciante são bem-vindas.', 'academia', 'corpo', true, NULL, 0),
  ('Corrida', 'corrida', 'Do primeiro quilômetro à prova. Conte o treino do dia e o que ajudou a sair de casa.', 'corrida', 'corpo', true, NULL, 0),
  ('Alimentação', 'alimentacao', 'Dicas de comida do dia a dia. Aqui valem dicas; promessa de emagrecer e números extremos não.', 'alimentacao', 'corpo', true, NULL, 0),
  ('Organização', 'organizacao', 'Casa, agenda, finanças e tarefas. O que você organizou hoje e como.', 'organizacao', 'rotina', true, NULL, 0),
  ('Sono', 'sono', 'Horário de dormir, rotina da noite e o que ajuda a acordar melhor.', 'sono', 'rotina', true, NULL, 0)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('014_default_communities')
ON CONFLICT (version) DO NOTHING;

COMMIT;
