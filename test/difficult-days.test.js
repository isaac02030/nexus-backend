const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DIFFICULT_CONSECUTIVE_MESSAGE,
  DIFFICULT_LIMIT_MESSAGE,
  validateDifficultDay
} = require('../lib/difficult-days');

test('aceita de 0 a 3 dias difíceis já usados e recusa o quarto', () => {
  const used = [];

  for (let count = 0; count <= 4; count += 1) {
    const dayNumber = count * 2 + 1;
    const result = validateDifficultDay({ difficultDays: used, dayNumber });

    if (count < 4) {
      assert.equal(result.ok, true, `com ${count} dias usados o dia ${dayNumber} entra`);
      used.push(dayNumber);
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.error, DIFFICULT_LIMIT_MESSAGE);
    }
  }

  assert.deepEqual(used, [1, 3, 5, 7]);
});

test('bloqueia o terceiro dia seguido e aceita outro depois de um intervalo', () => {
  assert.equal(validateDifficultDay({ difficultDays: [], dayNumber: 1 }).ok, true);
  assert.equal(validateDifficultDay({ difficultDays: [1], dayNumber: 2 }).ok, true);

  const third = validateDifficultDay({ difficultDays: [1, 2], dayNumber: 3 });
  assert.equal(third.ok, false);
  assert.equal(third.error, DIFFICULT_CONSECUTIVE_MESSAGE);

  const laterPair = validateDifficultDay({ difficultDays: [4, 5], dayNumber: 6 });
  assert.equal(laterPair.ok, false);
  assert.equal(laterPair.error, DIFFICULT_CONSECUTIVE_MESSAGE);

  assert.equal(validateDifficultDay({ difficultDays: [1, 2], dayNumber: 4 }).ok, true);
  assert.equal(validateDifficultDay({ difficultDays: [4, 5], dayNumber: 7 }).ok, true);
  assert.equal(validateDifficultDay({ difficultDays: [1, 2, 4], dayNumber: 5 }).ok, true);
});

test('o dia de hoje não entra de novo na conta', () => {
  const again = validateDifficultDay({
    difficultDays: [1, 3, 5, 7],
    dayNumber: 7
  });
  assert.equal(again.ok, true);

  const stillBlocked = validateDifficultDay({
    difficultDays: [1, 3, 5, 7],
    dayNumber: 9
  });
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.error, DIFFICULT_LIMIT_MESSAGE);

  const consecutiveFirst = validateDifficultDay({
    difficultDays: [1, 2, 4, 5],
    dayNumber: 6
  });
  assert.equal(consecutiveFirst.ok, false);
  assert.equal(consecutiveFirst.error, DIFFICULT_LIMIT_MESSAGE);
});
