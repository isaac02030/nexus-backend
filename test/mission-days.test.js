const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MISSION_WEEKDAYS_FORMAT_MESSAGE,
  MISSION_WEEKDAYS_MIN_MESSAGE,
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
} = require('../lib/mission-days');
const { calculateRecoveryState, missedDaysBeforeToday } = require('../lib/recovery-state');
const {
  DIFFICULT_CONSECUTIVE_MESSAGE,
  DIFFICULT_FREE_DAY_MESSAGE,
  validateDifficultDay
} = require('../lib/difficult-days');

const root = path.join(__dirname, '..');

// Dia 1 numa segunda. Dias da missão: segunda, quarta e sexta.
// Dia 1 seg, 2 ter (livre), 3 qua, 4 qui (livre), 5 sex, 6 sáb (livre), 7 dom (livre), 8 seg...
const monWedFri = missionDayChecker([1, 3, 5], 1);

test('contrato: sem escolha valem todos os dias (NULL)', () => {
  assert.deepEqual(validateMissionWeekdays(undefined), { ok: true, value: null });
  assert.deepEqual(validateMissionWeekdays(null), { ok: true, value: null });
});

test('contrato: de 3 a 7 dias, ordenados', () => {
  assert.deepEqual(validateMissionWeekdays([5, 1, 3]), { ok: true, value: [1, 3, 5] });
  assert.deepEqual(validateMissionWeekdays([7, 6, 5, 4, 3, 2, 1]), { ok: true, value: [1, 2, 3, 4, 5, 6, 7] });
});

test('contrato negado: menos de 3 dias', () => {
  for (const value of [[], [1], [1, 2]]) {
    assert.deepEqual(validateMissionWeekdays(value), { ok: false, error: MISSION_WEEKDAYS_MIN_MESSAGE });
  }
});

test('contrato negado: dia fora de 1 a 7, repetido, texto ou formato errado', () => {
  const bad = [
    [0, 1, 2],
    [1, 2, 8],
    [1, 1, 2, 3],
    [1, 2, 3, 4, 5, 6, 7, 1],
    ['1', '2', '3'],
    [1.5, 2, 3],
    [1, null, 3],
    'seg,qua,sex',
    3,
    { 1: true },
    true
  ];
  for (const value of bad) {
    assert.deepEqual(
      validateMissionWeekdays(value),
      { ok: false, error: MISSION_WEEKDAYS_FORMAT_MESSAGE },
      JSON.stringify(value)
    );
  }
});

test('valor do banco: estranho ou 7 dias vira "todos os dias"', () => {
  assert.equal(normalizeStoredWeekdays(null), null);
  assert.equal(normalizeStoredWeekdays(undefined), null);
  assert.equal(normalizeStoredWeekdays([1, 2, 3, 4, 5, 6, 7]), null);
  assert.equal(normalizeStoredWeekdays([1, 2]), null);
  assert.equal(normalizeStoredWeekdays([1, 9, 3]), null);
  assert.equal(normalizeStoredWeekdays('{1,3,5}'), null);
  assert.deepEqual(normalizeStoredWeekdays([5, 3, 1]), [1, 3, 5]);
});

test('dia da semana ISO a partir da data local', () => {
  assert.equal(isoWeekdayFromDateKey('2026-11-23'), 1);
  assert.equal(isoWeekdayFromDateKey('2026-11-22'), 7);
  assert.equal(isoWeekdayFromDateKey('não é data'), null);
});

test('o Dia 1 usa a data local do fuso da pessoa', () => {
  // 23:30 UTC de domingo: ainda domingo em São Paulo, já segunda em Tóquio.
  assert.equal(startWeekdayFor('2026-11-22T23:30:00Z', 'America/Sao_Paulo'), 7);
  assert.equal(startWeekdayFor('2026-11-22T23:30:00Z', 'Asia/Tokyo'), 1);
  assert.equal(startWeekdayFor(null, 'Europe/Lisbon'), null);
  assert.equal(startWeekdayFor('lixo', null), null);
});

test('o Dia N cai N - 1 dias depois do Dia 1', () => {
  assert.equal(weekdayForDay(1, 1), 1);
  assert.equal(weekdayForDay(1, 7), 7);
  assert.equal(weekdayForDay(1, 8), 1);
  assert.equal(weekdayForDay(7, 2), 1);
  assert.equal(weekdayForDay(3, 30), 4);
});

test('dias da missão e dias livres', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(monWedFri), [true, false, true, false, true, false, false, true]);
  const all = missionDayChecker(null, 1);
  assert.equal([1, 2, 3, 30].every(all), true);
  // Sem saber o dia da semana do Dia 1, não some nenhum dia da missão.
  assert.equal([1, 2, 3].every(missionDayChecker([1, 3, 5], null)), true);
});

test('contagem, dia anterior e último dia da missão', () => {
  assert.equal(countMissionDays(7, monWedFri), 3);
  assert.equal(countMissionDays(7), 7);
  assert.equal(previousMissionDay(5, monWedFri), 3);
  assert.equal(previousMissionDay(8, monWedFri), 5);
  assert.equal(previousMissionDay(1, monWedFri), 0);
  // Dia 30 numa terça (livre): o último dia da missão é o 29 (segunda).
  assert.equal(lastMissionDay(30, monWedFri), 29);
  // Quarta a sexta: o Dia 30 (terça) e os dias 27 a 29 são livres.
  assert.equal(lastMissionDay(30, missionDayChecker([3, 4, 5], 1)), 26);
  assert.equal(lastMissionDay(30), 30);
});

test('sequência: dia livre não soma nem quebra', () => {
  assert.equal(currentStreak(new Set([1, 3, 5]), 7, monWedFri), 3);
  assert.equal(currentStreak(new Set([1, 5]), 7, monWedFri), 1);
  // Hoje (dia da missão) sem check-in ainda quebra, como antes.
  assert.equal(currentStreak(new Set([1, 3, 5]), 8, monWedFri), 0);
  // Sem dias escolhidos: igual a antes.
  assert.equal(currentStreak(new Set([1, 2, 3]), 3), 3);
  assert.equal(currentStreak(new Set([1, 3]), 3), 1);
});

test('recuperação: dia livre não é falta', () => {
  // Fez o Dia 1; hoje é o Dia 3. O Dia 2 é livre: nada falhou.
  const ok = calculateRecoveryState(new Set([1]), 3, monWedFri);
  assert.equal(ok.missed_yesterday, false);
  assert.equal(ok.missed_days_before_today, 0);
  assert.equal(ok.missed_days, 1);
  assert.equal(ok.recovery_needed, false);

  // Não fez o Dia 1; hoje é o Dia 3. Conta 1 falta, não 2.
  const missed = calculateRecoveryState(new Set(), 3, monWedFri);
  assert.equal(missed.missed_yesterday, true);
  assert.equal(missed.missed_days_before_today, 1);
  assert.equal(missed.missed_days, 2);
  assert.equal(missed.recovery_needed, true);
  assert.equal(missedDaysBeforeToday(new Set(), 3, monWedFri), 1);

  // Hoje é dia livre: não pede recuperação, e hoje não conta como falta.
  const free = calculateRecoveryState(new Set(), 2, monWedFri);
  assert.equal(free.missed_yesterday, true);
  assert.equal(free.missed_days, 1);
  assert.equal(free.recovery_needed, false);
});

test('recuperação sem dias escolhidos continua igual', () => {
  assert.deepEqual(calculateRecoveryState(new Set(), 2), {
    missed_yesterday: true,
    missed_days: 2,
    missed_days_before_today: 1,
    recovery_needed: true
  });
  assert.deepEqual(calculateRecoveryState(new Set([1]), 2), {
    missed_yesterday: false,
    missed_days: 1,
    missed_days_before_today: 0,
    recovery_needed: false
  });
});

test('dia difícil: livre no meio quebra os 2 seguidos', () => {
  // Seg, ter, qua e sex. Dia 4 (quinta) é livre.
  const check = missionDayChecker([1, 2, 3, 5], 1);
  assert.deepEqual(validateDifficultDay({ difficultDays: [2, 3], dayNumber: 5, isMissionDay: check }), { ok: true });
  assert.deepEqual(
    validateDifficultDay({ difficultDays: [1, 2], dayNumber: 3, isMissionDay: check }),
    { ok: false, error: DIFFICULT_CONSECUTIVE_MESSAGE }
  );
});

test('dia difícil negado num dia livre', () => {
  assert.deepEqual(
    validateDifficultDay({ difficultDays: [], dayNumber: 2, isMissionDay: monWedFri }),
    { ok: false, error: DIFFICULT_FREE_DAY_MESSAGE }
  );
  // Sem isMissionDay, igual a antes.
  assert.deepEqual(validateDifficultDay({ difficultDays: [], dayNumber: 2 }), { ok: true });
});

test('a migração 004 só acrescenta a coluna dos dias da missão', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations', '004_mission_weekdays.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.match(code, /ADD COLUMN IF NOT EXISTS mission_weekdays SMALLINT\[\]/i);
  assert.doesNotMatch(code, /mission_weekdays SMALLINT\[\][^;]*NOT NULL/i);
  assert.match(code, /BETWEEN 3 AND 7/);
  assert.match(code, /IF NOT EXISTS/);
  assert.doesNotMatch(code, /\bDROP\b/i);
  assert.doesNotMatch(code, /\bUPDATE\b/i);
  assert.doesNotMatch(code, /\bDELETE\b/i);
  assert.match(code, /'004_mission_weekdays'/);
});
