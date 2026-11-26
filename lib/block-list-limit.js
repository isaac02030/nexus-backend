// ============================================
// NEXUS — Limite das rotas da lista de bloqueios
//
// Sem pacote novo. O mesmo freio em memória de lib/password-attempts.js,
// por pessoa e por processo:
//   GET    /api/users/me/blocks           30 por minuto
//   DELETE /api/users/me/blocks/:blockId  10 por hora
// Acima disso a rota responde 429. Reiniciar o servidor zera a contagem.
// Não é uma trava perfeita: com vários processos, cada um conta o seu.
//
// Os números são a hipótese do desenho de 26/11/2026. Ajustam-se aqui.
// ============================================

const GET_LIMIT = 30;
const GET_WINDOW_MS = 60 * 1000;
const DELETE_LIMIT = 10;
const DELETE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED = 10000;

const buckets = new Map();

function windowOf(key) {
  return key.startsWith('delete:') ? DELETE_WINDOW_MS : GET_WINDOW_MS;
}

function makeRoom(now) {
  if (buckets.size < MAX_TRACKED) return;
  for (const [key, entry] of buckets) {
    if (now - entry.firstAt >= windowOf(key)) buckets.delete(key);
  }
  if (buckets.size >= MAX_TRACKED) buckets.delete(buckets.keys().next().value);
}

// Janela fixa a partir do primeiro pedido. Devolve { ok, retryAfter }.
function consume(kind, userId, limit, windowMs, now = Date.now()) {
  const key = `${kind}:${Number(userId)}`;
  let entry = buckets.get(key);
  if (entry && now - entry.firstAt >= windowMs) {
    buckets.delete(key);
    entry = null;
  }
  if (!entry) {
    makeRoom(now);
    entry = { count: 0, firstAt: now };
    buckets.set(key, entry);
  }
  if (entry.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((entry.firstAt + windowMs - now) / 1000));
    return { ok: false, retryAfter };
  }
  entry.count += 1;
  return { ok: true, retryAfter: 0 };
}

function consumeBlockListRead(userId, now) {
  return consume('get', userId, GET_LIMIT, GET_WINDOW_MS, now);
}

function consumeBlockListDelete(userId, now) {
  return consume('delete', userId, DELETE_LIMIT, DELETE_WINDOW_MS, now);
}

function resetBlockListLimits() {
  buckets.clear();
}

module.exports = {
  BLOCK_LIST_GET_LIMIT: GET_LIMIT,
  BLOCK_LIST_GET_WINDOW_MS: GET_WINDOW_MS,
  BLOCK_LIST_DELETE_LIMIT: DELETE_LIMIT,
  BLOCK_LIST_DELETE_WINDOW_MS: DELETE_WINDOW_MS,
  consumeBlockListRead,
  consumeBlockListDelete,
  resetBlockListLimits
};
