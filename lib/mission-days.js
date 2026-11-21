// Dias da missão (planejamento semanal).
//
// No contrato, a pessoa escolhe os dias fixos da semana em que a missão
// acontece: de 3 a 7 por semana (1 = segunda ... 7 = domingo, como na ISO).
// Os outros são dias livres: não são falta, não são dia difícil, não têm
// lembrete e não pedem check-in. A missão continua com 30 dias corridos,
// então o "Dia N" e o fim não mudam.
// Sem escolha (NULL no banco), valem os 7 dias, como antes.
//
// O dia da semana do Dia N vem da data local do Dia 1 (o mesmo corte de
// dayNumberFor: fuso da pessoa quando ela escolheu horário e fuso; senão, o
// relógio do servidor) mais N - 1 dias de calendário.

const { getLocalDateKey } = require('./reminder-schedule');

const MIN_MISSION_WEEKDAYS = 3;
const MAX_MISSION_WEEKDAYS = 7;

const MISSION_WEEKDAYS_FORMAT_MESSAGE =
  'Escolha os dias da missão de segunda (1) a domingo (7), sem repetir.';
const MISSION_WEEKDAYS_MIN_MESSAGE =
  'Escolha pelo menos 3 dias da missão por semana.';
const FREE_DAY_CHECKIN_MESSAGE =
  'Hoje é dia livre na sua missão, não precisa de check-in. O próximo é no dia da missão.';

function isWeekday(value) {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

// Entrada do contrato. undefined ou null = todos os dias (guarda NULL).
function validateMissionWeekdays(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || !value.every(isWeekday)) {
    return { ok: false, error: MISSION_WEEKDAYS_FORMAT_MESSAGE };
  }
  const unique = new Set(value);
  if (unique.size !== value.length) {
    return { ok: false, error: MISSION_WEEKDAYS_FORMAT_MESSAGE };
  }
  if (unique.size < MIN_MISSION_WEEKDAYS || unique.size > MAX_MISSION_WEEKDAYS) {
    return { ok: false, error: MISSION_WEEKDAYS_MIN_MESSAGE };
  }
  return { ok: true, value: [...unique].sort((a, b) => a - b) };
}

// Valor lido do banco. Qualquer coisa fora da regra vale como "todos os dias":
// na dúvida, a missão se comporta como antes, e nunca some um dia da missão
// por causa de um dado estranho.
function normalizeStoredWeekdays(value) {
  if (!Array.isArray(value)) return null;
  const days = value.map(Number);
  const checked = validateMissionWeekdays(days);
  if (!checked.ok || checked.value === null || checked.value.length === 7) return null;
  return checked.value;
}

// 'AAAA-MM-DD' -> 1 (segunda) ... 7 (domingo).
function isoWeekdayFromDateKey(dateKey) {
  const match = typeof dateKey === 'string' && dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(utc.getTime())) return null;
  const sunday0 = utc.getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

// Dia da semana do Dia 1. Com fuso (horário escolhido), a data local de
// started_at nesse fuso, como getMissionDayNumber. Sem fuso, o relógio do
// servidor, como getLegacyMissionDayNumber (períodos de 24h a partir do
// início, então o Dia N cai sempre N - 1 dias de calendário depois).
function startWeekdayFor(startedAt, zone = null) {
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (startedAt == null || Number.isNaN(started.getTime())) return null;
  if (zone) return isoWeekdayFromDateKey(getLocalDateKey(started, zone));
  const sunday0 = started.getDay();
  return sunday0 === 0 ? 7 : sunday0;
}

// Dia da semana do Dia N, sabendo o dia da semana do Dia 1.
function weekdayForDay(startWeekday, dayNumber) {
  const start = Number(startWeekday);
  const day = Number(dayNumber);
  if (!isWeekday(start) || !Number.isInteger(day)) return null;
  return (((start - 1 + day - 1) % 7) + 7) % 7 + 1;
}

// Devolve (dia) => true quando o Dia N é dia da missão.
// Sem dias escolhidos, ou sem saber o dia da semana do Dia 1, todo dia é da missão.
function missionDayChecker(missionWeekdays, startWeekday) {
  const days = normalizeStoredWeekdays(missionWeekdays);
  if (!days || !isWeekday(Number(startWeekday))) return () => true;
  const chosen = new Set(days);
  return (dayNumber) => chosen.has(weekdayForDay(startWeekday, dayNumber));
}

function asChecker(isMissionDay) {
  return typeof isMissionDay === 'function' ? isMissionDay : () => true;
}

// O dia da missão mais recente antes de dayNumber, ou 0 se não houver.
function previousMissionDay(dayNumber, isMissionDay) {
  const check = asChecker(isMissionDay);
  for (let day = Number(dayNumber) - 1; day >= 1; day -= 1) {
    if (check(day)) return day;
  }
  return 0;
}

// Quantos dias da missão existem de 1 até throughDay (inclusive).
function countMissionDays(throughDay, isMissionDay) {
  const check = asChecker(isMissionDay);
  let total = 0;
  for (let day = 1; day <= Number(throughDay); day += 1) {
    if (check(day)) total += 1;
  }
  return total;
}

// O último dia da missão até durationDays: o Dia 30, ou o dia da missão mais
// recente antes dele quando o fim cai em dia livre. Fazer esse dia conclui a
// missão (antes, só o Dia 30 concluía; num dia livre ela travaria).
function lastMissionDay(durationDays, isMissionDay) {
  const duration = Number(durationDays);
  if (!Number.isInteger(duration) || duration < 1) return duration;
  const check = asChecker(isMissionDay);
  for (let day = duration; day >= 1; day -= 1) {
    if (check(day)) return day;
  }
  return duration;
}

// Sequência atual: dias da missão concluídos, seguidos, contando de hoje
// para trás. O dia livre não soma nem quebra. Hoje ainda sem check-in
// quebra, como antes.
function currentStreak(doneDays, todayDay, isMissionDay) {
  const check = asChecker(isMissionDay);
  let streak = 0;
  for (let day = Number(todayDay); day >= 1; day -= 1) {
    if (!check(day)) continue;
    if (doneDays.has(day)) streak += 1;
    else break;
  }
  return streak;
}

module.exports = {
  MIN_MISSION_WEEKDAYS,
  MAX_MISSION_WEEKDAYS,
  MISSION_WEEKDAYS_FORMAT_MESSAGE,
  MISSION_WEEKDAYS_MIN_MESSAGE,
  FREE_DAY_CHECKIN_MESSAGE,
  validateMissionWeekdays,
  normalizeStoredWeekdays,
  isoWeekdayFromDateKey,
  startWeekdayFor,
  weekdayForDay,
  missionDayChecker,
  previousMissionDay,
  countMissionDays,
  lastMissionDay,
  currentStreak
};
