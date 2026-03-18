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
    // Encriptar a password (nunca guardamos em texto simples)
    const hash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO users (username, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at`,
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

module.exports = router;
