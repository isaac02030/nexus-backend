// ============================================
// NEXUS — Rotas de Utilizadores
// Registo e Login
// ============================================

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');
const router   = express.Router();

// Ligação à base de dados
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function ensureUserProfileColumns() {
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_url TEXT
  `);
}

// ============================================
// REGISTO
// POST /api/users/register
// Body: { username, email, password }
// ============================================
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  // Validação básica
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password deve ter pelo menos 6 caracteres.' });
  }

  try {
    await ensureUserProfileColumns();

    // Encriptar a password (nunca guardamos em texto simples)
    const hash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO users (username, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, bio, avatar_url, created_at, updated_at`,
      [username, email, hash]
    );

    const user = result.rows[0];

    // Criar token JWT — é como um "cartão de identificação" digital
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ user, token });

  } catch (err) {
    // Erro de duplicado (email ou username já existe)
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email ou username já está em uso.' });
    }
    res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

// ============================================
// LOGIN
// POST /api/users/login
// Body: { email, password }
// ============================================
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password são obrigatórios.' });
  }

  try {
    await ensureUserProfileColumns();

    // Procurar o utilizador pelo email
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Comparar a password com o hash guardado
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Gerar novo token
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Devolver utilizador (sem a password) + token
    const { password: _, ...userSafe } = user;
    res.json({ user: userSafe, token });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer login.' });
  }
});

// ============================================
// ATUALIZAR PERFIL
// PUT /api/users/profile
// Body: { username, bio }
// ============================================
const auth = require('../middleware/auth');

router.get('/me', auth, async (req, res) => {
  try {
    await ensureUserProfileColumns();

    const result = await db.query(
      `SELECT id, username, email, bio, avatar_url, created_at, updated_at
       FROM users
       WHERE id = $1`,
      [req.user.userId]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Utilizador nao encontrado.' });
    }

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar sessao.' });
  }
});

router.put('/profile', auth, async (req, res) => {
  const { username, bio, avatar_url } = req.body;
  const userId = req.user.userId;

  if (!username?.trim()) {
    return res.status(400).json({ error: 'Username não pode estar vazio.' });
  }

  try {
    // Verificar se username já está em uso por outro utilizador
    await ensureUserProfileColumns();
    const existing = await db.query(
      'SELECT id FROM users WHERE username = $1 AND id != $2',
      [username.trim(), userId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Este username já está em uso.' });
    }

    const safeAvatarUrl = avatar_url?.trim() || null;
    if (safeAvatarUrl && !/^https?:\/\//i.test(safeAvatarUrl)) {
      return res.status(400).json({ error: 'A foto precisa ser um link http ou https.' });
    }

    const result = await db.query(
      `UPDATE users SET username = $1, bio = $2, avatar_url = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, username, email, bio, avatar_url, created_at, updated_at`,
      [username.trim(), bio?.trim() || null, safeAvatarUrl, userId]
    );

    const user = result.rows[0];

    // Gerar novo token com username atualizado
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ user, token, message: 'Perfil atualizado!' });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar perfil.' });
  }
});

module.exports = router;
