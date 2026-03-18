// ============================================
// NEXUS — Middleware de Autenticação
// Verifica se o utilizador tem um token válido
// antes de aceder a rotas protegidas
// ============================================

const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  // O token vem no header: Authorization: Bearer <token>
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Guardamos os dados do utilizador na req
    next();             // Continua para a rota seguinte
  } catch (err) {
    res.status(403).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = auth;
