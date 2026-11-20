const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRecoveryState } = require('../lib/recovery-state');

test('ontem sem check-in conta 1 e o dia de hoje fica de fora', () => {
  const open = calculateRecoveryState(new Set(), 2);
  assert.equal(open.missed_days_before_today, 1);
  assert.equal(open.missed_days, 2);
  assert.equal(open.recovery_needed, true);

  assert.equal(calculateRecoveryState(new Set(), 1).missed_days_before_today, 0);
  assert.equal(calculateRecoveryState(new Set([1]), 2).missed_days_before_today, 0);
  assert.equal(calculateRecoveryState(new Set(), 0).missed_days_before_today, 0);
  assert.equal(calculateRecoveryState(new Set(), -3).missed_days_before_today, 0);
});

test('três dias passados sem check-in contam 3', () => {
  const open = calculateRecoveryState(new Set(), 4);
  assert.equal(open.missed_days_before_today, 3);
  assert.equal(open.missed_days, 4);

  const afterAnOlderCheckin = calculateRecoveryState(new Set([2]), 6);
  assert.equal(afterAnOlderCheckin.missed_days_before_today, 3);
  assert.equal(afterAnOlderCheckin.missed_days, 4);
});

test('registrar hoje com ontem vazio tira a recuperação e mantém a conta anterior', () => {
  const before = calculateRecoveryState(new Set(), 2);
  const after = calculateRecoveryState(new Set([2]), 2);

  assert.equal(before.missed_days_before_today, 1);
  assert.equal(before.recovery_needed, true);
  assert.equal(after.recovery_needed, false);
  assert.equal(after.missed_days_before_today, before.missed_days_before_today);
  assert.equal(before.missed_days, 2);
  assert.equal(after.missed_days, 0);
});
