-- Maratona da comunidade refeita (PR E da comunidade, plano do Vitrúvio).
-- Só acrescenta: uma coluna nova (vazia) em community_missions e uma tabela
-- nova (vazia) para os check-ins da Maratona. Nenhuma linha existente muda.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- NÃO APLICAR sem o sim do dono do projeto; backup antes.
-- (A 016 ficou sem uso: o mérito do PR D é calculado na leitura.)
--
-- community_missions.start_day: o 1.º dia da Maratona, como data de Lisboa.
--   O dia N é start_day + N - 1, contado pelo relógio do banco em
--   Europe/Lisbon (antes: 24 horas corridas em UTC). Missões antigas ficam
--   com NULL e não aparecem (o código antigo delas não funcionava).
-- community_marathon_checkins: um registro por pessoa, maratona e dia
--   (UNIQUE). Antes, o check-in caía em checkins, que é das missões pessoais
--   (chave estrangeira para missions): dava 500 ou gravava na missão de
--   outra pessoa. Sem texto: nada de nota.
--
-- Dados pessoais: quem registrou que dia. Saem com a conta
-- (lib/account-deletion.js apaga de forma explícita; ON DELETE CASCADE como
-- segunda trava) e com a maratona.
--
-- Para voltar atrás (perde só os registros da Maratona e as datas de início):
--   DROP TABLE IF EXISTS community_marathon_checkins;
--   ALTER TABLE community_missions DROP COLUMN IF EXISTS start_day;
--   DELETE FROM schema_migrations WHERE version = '017_community_marathon';

BEGIN;

ALTER TABLE community_missions
  ADD COLUMN IF NOT EXISTS start_day DATE;

CREATE TABLE IF NOT EXISTS community_marathon_checkins (
  id SERIAL PRIMARY KEY,
  community_mission_id INTEGER NOT NULL REFERENCES community_missions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_date DATE NOT NULL,
  day_number INTEGER NOT NULL CHECK (day_number >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_mission_id, user_id, day_date)
);

COMMENT ON TABLE community_marathon_checkins IS
  'Registro do dia na Maratona da comunidade: 1 por pessoa por dia (data de Lisboa).';

CREATE INDEX IF NOT EXISTS idx_marathon_checkins_mission_day ON community_marathon_checkins(community_mission_id, day_number);
CREATE INDEX IF NOT EXISTS idx_marathon_checkins_user ON community_marathon_checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_community_missions_start ON community_missions(community_id, start_day);

INSERT INTO schema_migrations (version)
VALUES ('017_community_marathon')
ON CONFLICT (version) DO NOTHING;

COMMIT;
