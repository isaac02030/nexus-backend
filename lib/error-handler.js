// ============================================
// NEXUS — Tratamento final de erros
//
// Erros de leitura do pedido (por exemplo, JSON quebrado) trazem um
// pedaço do texto enviado na mensagem. Esse texto pode ser uma nota de
// crise, então nesses casos o log guarda só o tipo do erro.
// ============================================

function errorHandler(err, req, res, next) {
  const requestError = err && typeof err.type === 'string';
  console.error('Erro:', requestError ? err.type : (err && err.message));
  res.status(500).json({ error: 'Algo correu mal no servidor.' });
}

module.exports = { errorHandler };
