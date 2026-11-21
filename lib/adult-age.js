// ============================================
// NEXUS — Idade mínima no cadastro (18 anos)
//
// O cadastro pede a data de nascimento só para conferir a idade.
// A data NÃO é guardada nem logada: o banco guarda só a hora em que o
// servidor confirmou "maior de 18" (users.adult_confirmed_at). É o mínimo
// necessário (LGPD art. 6.º, III; RGPD art. 5.º, 1, c).
//
// Corte do dia: usamos a data no fuso mais atrasado do mundo (UTC-12).
// Assim ninguém faz 18 anos "antes da hora" por causa do fuso; no pior
// caso, quem faz aniversário hoje espera algumas horas.
// Quem nasceu em 29/02 faz 18 em 01/03 nos anos sem 29/02.
// ============================================

const ADULT_AGE = 18;
const OLDEST_YEAR = 1900;

const BIRTH_DATE_MISSING_MESSAGE = 'Falta a data de nascimento. Preencha e envie de novo.';
const BIRTH_DATE_INVALID_MESSAGE = 'A data de nascimento não parece certa. Use o formato dia, mês e ano e envie de novo.';
const UNDER_AGE_MESSAGE = 'O Nexus é só para maiores de 18 anos, por isso não dá para criar a conta agora. Nada do que você escreveu foi guardado.';

// "AAAA-MM-DD" → { y, m, d } ou null se não for uma data real.
function parseBirthDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  return { y, m, d };
}

// Hoje no fuso UTC-12.
function todayAtLatestZone(now = new Date()) {
  const shifted = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

function ageOn(birth, today) {
  let age = today.y - birth.y;
  if (today.m < birth.m || (today.m === birth.m && today.d < birth.d)) age -= 1;
  return age;
}

// { ok: true } ou { ok: false, status, error, under_age? }
function checkAdult(value, now = new Date()) {
  if (value == null || value === '') {
    return { ok: false, status: 400, error: BIRTH_DATE_MISSING_MESSAGE };
  }
  const birth = parseBirthDate(value);
  const today = todayAtLatestZone(now);
  if (!birth || birth.y < OLDEST_YEAR) {
    return { ok: false, status: 400, error: BIRTH_DATE_INVALID_MESSAGE };
  }
  const age = ageOn(birth, today);
  if (age < 0) {
    return { ok: false, status: 400, error: BIRTH_DATE_INVALID_MESSAGE };
  }
  if (age < ADULT_AGE) {
    return { ok: false, status: 403, error: UNDER_AGE_MESSAGE, under_age: true };
  }
  return { ok: true };
}

module.exports = {
  ADULT_AGE,
  BIRTH_DATE_MISSING_MESSAGE,
  BIRTH_DATE_INVALID_MESSAGE,
  UNDER_AGE_MESSAGE,
  parseBirthDate,
  todayAtLatestZone,
  ageOn,
  checkAdult
};
