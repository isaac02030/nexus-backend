// Critério de admin do servidor: o mesmo que routes/insights.js já usava
// (a conta de id 1, a do dono do projeto). Fica num lugar só para as rotas
// de moderação da comunidade usarem a mesma regra.

const ADMIN_USER_ID = 1;
const ADMIN_ONLY_MESSAGE = 'Esta area esta disponivel apenas para o admin.';

function isAdmin(user) {
  return !!user && user.userId === ADMIN_USER_ID;
}

// Responde 403 e devolve false se quem pede não é o admin.
function ensureAdmin(req, res) {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: ADMIN_ONLY_MESSAGE });
    return false;
  }
  return true;
}

module.exports = { ADMIN_USER_ID, ADMIN_ONLY_MESSAGE, isAdmin, ensureAdmin };
