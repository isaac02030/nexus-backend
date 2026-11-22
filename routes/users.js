// ============================================
// NEXUS — Rotas de Utilizadores
// Registo e Login
// ============================================

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { db } = require('../lib/db');
const { validateReminderPayload } = require('../lib/reminder-schedule');
const { checkAdult } = require('../lib/adult-age');
const { deleteAccountData } = require('../lib/account-deletion');
const { isAdmin } = require('../lib/admin');
const { lockedForSeconds, recordWrong, clearAttempts } = require('../lib/password-attempts');
const {
  NOTE_CONSENT_VERSION,
  NOTE_CONSENT_LOAD_ERROR,
  NOTE_CONSENT_SAVE_ERROR,
  NOTE_CONSENT_BODY_ERROR,
  consentSelectSql,
  consentPayload
} = require('../lib/note-consent');
const router   = express.Router();

const REGISTER_UNAVAILABLE_MESSAGE = 'O cadastro não está disponível agora. Tente de novo mais tarde.';

// ============================================
// REGISTO
// POST /api/users/register
// Body: { username, email, password, birth_date: "AAAA-MM-DD" }
//
// Só maiores de 18. A data de nascimento serve só para conferir a idade:
// não é gravada nem logada. O banco guarda só adult_confirmed_at (a hora
// da confirmação). Menor de 18: 403 calmo e nada gravado.
// ============================================
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};

  // Validação básica
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password deve ter pelo menos 6 caracteres.' });
  }

  const adult = checkAdult(req.body.birth_date);
  if (!adult.ok) {
    return res.status(adult.status).json({
      error: adult.error,
      ...(adult.under_age ? { under_age: true } : {})
    });
  }

  try {
    // Encriptar a password (nunca guardamos em texto simples)
    const hash = await bcrypt.hash(password, 10);

    // Precisa da migração 006 (users.adult_confirmed_at). Sem ela, o
    // cadastro não abre (503 calmo): não criamos conta sem guardar a
    // confirmação de idade.
    const result = await db.query(
      `INSERT INTO users (username, email, password, adult_confirmed_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, username, email, bio, avatar_url, created_at, updated_at,
                 adult_confirmed_at IS NOT NULL AS adult_confirmed`,
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
    if (err.code === '42703') {
      return res.status(503).json({ error: REGISTER_UNAVAILABLE_MESSAGE });
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

// ============================================
// ATUALIZAR PERFIL
// PUT /api/users/profile
// Body: { username, bio }
// ============================================
const auth = require('../middleware/auth');

router.get('/me', auth, async (req, res) => {
  try {
    const result = await db.query(
      // adult_confirmed: false para contas antigas (de antes da idade no
      // cadastro) e também antes da migração 006 (to_jsonb não quebra).
      `SELECT id, username, email, bio, avatar_url, created_at, updated_at,
              (to_jsonb(users) ->> 'adult_confirmed_at') IS NOT NULL AS adult_confirmed
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

router.get('/me/reminder', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone
       FROM users
       WHERE id = $1`,
      [req.user.userId]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Utilizador nao encontrado.' });
    }

    res.json({
      reminder_time: user.reminder_time,
      timezone: user.timezone || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar o lembrete.' });
  }
});

router.put('/me/reminder', auth, async (req, res) => {
  const validation = validateReminderPayload(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const result = await db.query(
      `UPDATE users
       SET reminder_time = $1::time, timezone = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING to_char(reminder_time, 'HH24:MI') AS reminder_time, timezone`,
      [validation.value.reminder_time, validation.value.timezone, req.user.userId]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Utilizador nao encontrado.' });
    }

    res.json({
      reminder_time: user.reminder_time,
      timezone: user.timezone || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao guardar o lembrete.' });
  }
});

// ============================================
// CONSENTIMENTO PARA GUARDAR A NOTA DO CHECK-IN (lib/note-consent.js)
// GET    /api/users/me/note-consent  → a escolha atual
// POST   /api/users/me/note-consent  → dar o consentimento
//        Body: { consent: true } (ação afirmativa; nada mais vale como sim)
// DELETE /api/users/me/note-consent  → «Não guardar» ou retirar: grava
//        "não" com a hora do servidor e apaga as notas já guardadas da
//        pessoa (o registro dos dias continua). Vale também para o primeiro
//        «Não guardar», para a pergunta não voltar.
// Resposta: { note_consent: "yes" | "no" | null, decided_at, version }
// (null = ainda não respondeu, vale como "não"). A data vem do servidor.
// Antes da migração 007: GET responde null; POST e DELETE respondem 503
// calmo, sem gravar nada (e o check-in já não guarda nota sem o sim).
// Nada do pedido vai para log.
// ============================================
router.get('/me/note-consent', auth, async (req, res) => {
  try {
    const result = await db.query(consentSelectSql(), [req.user.userId]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Utilizador nao encontrado.' });
    }
    return res.json(consentPayload(result.rows[0]));
  } catch (err) {
    return res.status(500).json({ error: NOTE_CONSENT_LOAD_ERROR });
  }
});

router.post('/me/note-consent', auth, async (req, res) => {
  if (!req.body || req.body.consent !== true) {
    return res.status(400).json({ error: NOTE_CONSENT_BODY_ERROR, code: 'consent_required' });
  }
  try {
    const result = await db.query(
      `UPDATE users
       SET note_consent = TRUE, note_consent_at = NOW(), note_consent_version = $2
       WHERE id = $1
       RETURNING note_consent::text AS choice, note_consent_at AS decided_at,
                 note_consent_version AS version`,
      [req.user.userId, NOTE_CONSENT_VERSION]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Utilizador nao encontrado.' });
    }
    return res.json(consentPayload(result.rows[0]));
  } catch (err) {
    if (err && err.code === '42703') {
      return res.status(503).json({ error: NOTE_CONSENT_SAVE_ERROR, code: 'consent_unavailable' });
    }
    return res.status(500).json({ error: NOTE_CONSENT_SAVE_ERROR });
  }
});

router.delete('/me/note-consent', auth, async (req, res) => {
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    // O UPDATE trava a linha da pessoa. O check-in trava a mesma linha
    // (FOR SHARE) antes de ler a escolha: ou ele termina antes (e a nota
    // dele é apagada abaixo), ou espera e já lê o "não".
    const result = await client.query(
      `UPDATE users
       SET note_consent = FALSE, note_consent_at = NOW(), note_consent_version = $2
       WHERE id = $1
       RETURNING note_consent::text AS choice, note_consent_at AS decided_at,
                 note_consent_version AS version`,
      [req.user.userId, NOTE_CONSENT_VERSION]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Utilizador nao encontrado.' });
    }
    // Só as notas DESTA pessoa (as do parceiro no Duo ficam).
    const cleared = await client.query(
      `UPDATE checkins SET note = NULL
       WHERE user_id = $1 AND note IS NOT NULL`,
      [req.user.userId]
    );
    await client.query('COMMIT');
    return res.json({
      ...consentPayload(result.rows[0]),
      notes_deleted: cleared && typeof cleared.rowCount === 'number' ? cleared.rowCount : 0
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    if (err && err.code === '42703') {
      return res.status(503).json({ error: NOTE_CONSENT_SAVE_ERROR, code: 'consent_unavailable' });
    }
    return res.status(500).json({ error: NOTE_CONSENT_SAVE_ERROR });
  } finally {
    if (client) client.release();
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

// ============================================
// EXCLUIR A CONTA
// DELETE /api/users/me
// Body: { password }
//
// Pede a senha atual (spec da Clara: «Digite sua senha para confirmar»).
// Senha errada: 403 com code "wrong_password" e nada apagado. Apaga tudo
// numa transação (lib/account-deletion.js). Depois, o middleware de login
// recusa o token (a conta não existe mais). Sem prazo de arrependimento:
// apaga na hora (decisão de 22/11). Nada do pedido vai para log.
// A conta de admin não se exclui por aqui (403). Senhas erradas demais:
// 429 por 15 minutos (lib/password-attempts.js).
// ============================================
const ACCOUNT_DELETE_PASSWORD_MESSAGE = 'Digite sua senha para confirmar.';
const ACCOUNT_DELETE_WRONG_PASSWORD_MESSAGE = 'Senha incorreta. Sua conta não foi excluída.';
const ACCOUNT_DELETE_FAILED_MESSAGE = 'Não foi possível excluir agora. Tente de novo.';
const ACCOUNT_DELETE_ADMIN_MESSAGE = 'A conta de administração não pode ser excluída por aqui.';
const ACCOUNT_DELETE_TOO_MANY_MESSAGE = 'Muitas tentativas com a senha errada. Sua conta não foi excluída. Tente de novo em 15 minutos.';

function tooMany(res, seconds) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: ACCOUNT_DELETE_TOO_MANY_MESSAGE, code: 'too_many_attempts' });
}

router.delete('/me', auth, async (req, res) => {
  const userId = Number(req.user.userId);
  const password = req.body?.password;

  if (isAdmin(req.user)) {
    return res.status(403).json({ error: ACCOUNT_DELETE_ADMIN_MESSAGE, code: 'admin_account' });
  }

  const lockedBefore = lockedForSeconds(userId);
  if (lockedBefore) return tooMany(res, lockedBefore);

  if (typeof password !== 'string' || password.length === 0 || password.length > 200) {
    return res.status(400).json({ error: ACCOUNT_DELETE_PASSWORD_MESSAGE, code: 'password_required' });
  }

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    // Trava a linha da pessoa: um check-in, post ou mensagem ao mesmo tempo
    // espera e depois falha pela chave estrangeira, sem deixar resto.
    const userRes = await client.query(
      'SELECT id, password FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = userRes.rows[0];
    // De novo com a linha travada: pedidos ao mesmo tempo esperam aqui um
    // pelo outro e veem a contagem do anterior.
    const lockedNow = lockedForSeconds(userId);
    if (lockedNow) {
      await client.query('ROLLBACK');
      return tooMany(res, lockedNow);
    }
    const valid = user ? await bcrypt.compare(password, user.password) : false;
    if (!valid) {
      const lockedAfter = recordWrong(userId);
      await client.query('ROLLBACK');
      if (lockedAfter) return tooMany(res, lockedAfter);
      return res.status(403).json({ error: ACCOUNT_DELETE_WRONG_PASSWORD_MESSAGE, code: 'wrong_password' });
    }

    await deleteAccountData(client, userId);
    await client.query('COMMIT');
    clearAttempts(userId);
    return res.json({ deleted: true });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* nada a desfazer */ }
    }
    // Só o tipo do erro: nada do pedido nem dos dados.
    console.error('Account deletion error:', (err && (err.code || err.name)) || 'unknown');
    return res.status(500).json({ error: ACCOUNT_DELETE_FAILED_MESSAGE });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
