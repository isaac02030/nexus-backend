// ============================================
// NEXUS — Middleware de Autenticação
// Verifica se o utilizador tem um token válido
// antes de aceder a rotas protegidas
//
// Além do token, confere a cada pedido que a conta ainda existe
// (SELECT 1 por id, chave primária). Conta excluída = 401, mesmo depois
// de reiniciar o servidor. Banco fora = 503: falha fechado, nunca deixa
// passar sem conferir.
// ============================================

const jwt = require('jsonwebtoken');
const { db } = require('../lib/db');

const SESSION_ENDED_MESSAGE = 'Sessão encerrada. Entre de novo.';
const AUTH_UNAVAILABLE_MESSAGE = 'Não foi possível conferir sua sessão agora. Tente de novo em instantes.';

function validUserId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

async function auth(req, res, next) {
  // O token vem no header: Authorization: Bearer <token>
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }

  const userId = validUserId(decoded && decoded.userId);
  if (!userId) {
    return res.status(401).json({ error: SESSION_ENDED_MESSAGE });
  }

  let exists;
  try {
    const result = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    exists = result.rows.length > 0;
  } catch (err) {
    // Só o código do erro: nada do pedido.
    console.error('Auth check error:', (err && (err.code || err.name)) || 'unknown');
    return res.status(503).json({ error: AUTH_UNAVAILABLE_MESSAGE, code: 'auth_unavailable' });
  }

  if (!exists) {
    return res.status(401).json({ error: SESSION_ENDED_MESSAGE, code: 'session_ended' });
  }

  req.user = decoded; // Guardamos os dados do utilizador na req
  next();             // Continua para a rota seguinte
}

module.exports = auth;
module.exports.SESSION_ENDED_MESSAGE = SESSION_ENDED_MESSAGE;
module.exports.AUTH_UNAVAILABLE_MESSAGE = AUTH_UNAVAILABLE_MESSAGE;
