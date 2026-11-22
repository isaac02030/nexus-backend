// ============================================
// NEXUS — Limite de tentativas de senha (exclusão da conta)
//
// Sem pacote novo. Conta as senhas erradas por conta, na memória do
// processo: 5 erradas em 15 minutos bloqueiam por 15 minutos (429).
// A senha certa zera a contagem. Reiniciar o servidor zera tudo; é um
// freio para quem pegou um aparelho destravado, não uma trava perfeita.
// ============================================

const MAX_WRONG = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10000;

const attempts = new Map();

function current(key, now) {
  const entry = attempts.get(key);
  if (!entry) return null;
  if (entry.lockedUntil && entry.lockedUntil > now) return entry;
  if (!entry.lockedUntil && now - entry.firstAt <= WINDOW_MS) return entry;
  attempts.delete(key);
  return null;
}

// Segundos até poder tentar de novo, ou 0 se pode tentar agora.
function lockedForSeconds(key, now = Date.now()) {
  const entry = current(key, now);
  if (!entry || !entry.lockedUntil) return 0;
  return Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
}

function recordWrong(key, now = Date.now()) {
  let entry = current(key, now);
  if (!entry) {
    if (attempts.size >= MAX_TRACKED) {
      // Limpa o que já venceu; se ainda estiver cheio, tira o mais antigo.
      for (const [k] of attempts) current(k, now);
      if (attempts.size >= MAX_TRACKED) attempts.delete(attempts.keys().next().value);
    }
    entry = { count: 0, firstAt: now, lockedUntil: 0 };
    attempts.set(key, entry);
  }
  entry.count += 1;
  if (entry.count >= MAX_WRONG) entry.lockedUntil = now + WINDOW_MS;
  return lockedForSeconds(key, now);
}

function clearAttempts(key) {
  attempts.delete(key);
}

function resetAllAttempts() {
  attempts.clear();
}

module.exports = { MAX_WRONG, WINDOW_MS, lockedForSeconds, recordWrong, clearAttempts, resetAllAttempts };
