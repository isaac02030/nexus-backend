-- Dias da missão escolhidos no contrato: dias fixos da semana, de 3 a 7.
-- 1 = segunda ... 7 = domingo (ISO). NULL = todos os dias, como antes.
-- Os outros dias são dias livres: sem check-in, sem lembrete, sem falta.
-- Só acrescenta: missões que já existem ficam NULL e não mudam.
-- Safe to run more than once: no DROP, no UPDATE, no DELETE.
-- Para voltar atrás (apaga só a escolha de dias, nada mais):
--   ALTER TABLE missions DROP CONSTRAINT IF EXISTS missions_mission_weekdays_check;
--   ALTER TABLE missions DROP COLUMN IF EXISTS mission_weekdays;
--   DELETE FROM schema_migrations WHERE version = '004_mission_weekdays';

BEGIN;

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS mission_weekdays SMALLINT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'missions_mission_weekdays_check'
      AND conrelid = 'missions'::regclass
  ) THEN
    ALTER TABLE missions
      ADD CONSTRAINT missions_mission_weekdays_check CHECK (
        mission_weekdays IS NULL
        OR (
          cardinality(mission_weekdays) BETWEEN 3 AND 7
          AND array_position(mission_weekdays, NULL) IS NULL
          AND mission_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]
        )
      );
  END IF;
END
$$;

COMMENT ON COLUMN missions.mission_weekdays IS
  'Dias da semana da missão (1 = segunda ... 7 = domingo), de 3 a 7. NULL = todos os dias. Os outros são dias livres.';

INSERT INTO schema_migrations (version)
VALUES ('004_mission_weekdays')
ON CONFLICT (version) DO NOTHING;

COMMIT;
