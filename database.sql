-- ============================================
-- NEXUS — Schema da Base de Dados
-- PostgreSQL
-- ============================================

-- Limpar tabelas se já existirem (útil durante desenvolvimento)
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS checkins CASCADE;
DROP TABLE IF EXISTS missions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================
-- UTILIZADORES
-- Quem usa a plataforma
-- ============================================
CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(50)  UNIQUE NOT NULL,
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,         -- guardada com bcrypt (nunca em texto simples)
  bio         TEXT,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- MISSÕES
-- O coração da plataforma
-- ============================================
CREATE TABLE missions (
  id              SERIAL PRIMARY KEY,

  -- Quem criou e quem foi emparelhado
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  partner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- O objetivo em si
  title           VARCHAR(255) NOT NULL,     -- ex: "Correr 5km todos os dias"
  category        VARCHAR(100) NOT NULL,     -- ex: "fitness", "aprendizagem", "hábito"
  description     TEXT,
  level           VARCHAR(20) DEFAULT 'iniciante', -- iniciante / intermédio / avançado

  -- Modo da missão
  mode            VARCHAR(20) DEFAULT 'solo',  -- solo / parceiro / rival
  duration_days   INTEGER DEFAULT 30,

  -- Pontuação (usado no modo rival)
  user_score      INTEGER DEFAULT 0,
  partner_score   INTEGER DEFAULT 0,

  -- Estado
  status          VARCHAR(20) DEFAULT 'waiting', -- waiting / active / completed / abandoned
  started_at      TIMESTAMP,
  ends_at         TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- CHECK-INS
-- Registo diário do progresso
-- ============================================
CREATE TABLE checkins (
  id          SERIAL PRIMARY KEY,
  mission_id  INTEGER REFERENCES missions(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id)    ON DELETE CASCADE,
  day_number  INTEGER NOT NULL,              -- Dia 1, Dia 2, ... Dia 30
  completed   BOOLEAN DEFAULT FALSE,
  note        TEXT,                          -- nota opcional do utilizador
  created_at  TIMESTAMP DEFAULT NOW(),

  -- Garante que cada utilizador só faz 1 check-in por dia por missão
  UNIQUE(mission_id, user_id, day_number)
);

-- ============================================
-- MENSAGENS
-- Chat entre parceiro/rival
-- ============================================
CREATE TABLE messages (
  id          SERIAL PRIMARY KEY,
  mission_id  INTEGER REFERENCES missions(id) ON DELETE CASCADE,
  sender_id   INTEGER REFERENCES users(id)    ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- ÍNDICES — para tornar as queries mais rápidas
-- ============================================
CREATE INDEX idx_missions_user    ON missions(user_id);
CREATE INDEX idx_missions_partner ON missions(partner_id);
CREATE INDEX idx_missions_status  ON missions(status);
CREATE INDEX idx_checkins_mission ON checkins(mission_id);
CREATE INDEX idx_messages_mission ON messages(mission_id);

-- ============================================
-- DADOS DE TESTE (opcional, para desenvolvimento)
-- ============================================
INSERT INTO users (username, email, password) VALUES
  ('isaac_dev', 'isaac@nexus.com', '$2b$10$placeholder_hash'),
  ('rival_teste', 'rival@nexus.com', '$2b$10$placeholder_hash');

INSERT INTO missions (user_id, title, category, level, mode, status) VALUES
  (1, 'Correr 5km todos os dias', 'fitness', 'iniciante', 'rival', 'active');
