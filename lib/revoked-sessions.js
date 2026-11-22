// ============================================
// NEXUS — Sessões encerradas pela exclusão da conta
//
// O token é um JWT de 7 dias guardado no aparelho; o servidor não guarda
// sessões. Ao excluir a conta, o id da pessoa entra aqui e o middleware de
// login recusa qualquer token dela, neste processo.
//
// Limite conhecido (sem migração): a lista vive na memória. Depois de um
// reinício do servidor, um token antigo volta a passar pelo middleware até
// expirar (no máximo 7 dias), mas a conta não existe mais: o login falha,
// as leituras voltam vazias e as gravações falham pela chave estrangeira
// (users). Os ids são SERIAL e não se repetem.
// ============================================

const revokedUserIds = new Set();

function revokeUserSessions(userId) {
  const id = Number(userId);
  if (Number.isInteger(id) && id > 0) revokedUserIds.add(id);
}

function isUserRevoked(userId) {
  return revokedUserIds.has(Number(userId));
}

module.exports = { revokeUserSessions, isUserRevoked };
