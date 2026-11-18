const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BOTH_REQUIRED_MESSAGE,
  REMINDER_TIME_MESSAGE,
  TIMEZONE_MESSAGE,
  getDueReminders,
  getReminderSlots,
  resolveReminderSettings,
  validateReminderPayload
} = require('../lib/reminder-schedule');

function dueSlots(options) {
  const due = getDueReminders({
    hasActiveMission: true,
    checkedInToday: false,
    alreadySent: [],
    ...options
  });

  for (const item of due) {
    assert.equal(item.countsTowardChatLimit, false);
  }

  return due;
}

test('valida HH:MM e fuso IANA', () => {
  const ok = validateReminderPayload({
    reminder_time: ' 09:05 ',
    timezone: ' utc '
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { reminder_time: '09:05', timezone: 'UTC' });

  assert.equal(validateReminderPayload({
    reminder_time: '00:00',
    timezone: 'America/Sao_Paulo'
  }).ok, true);
  assert.equal(validateReminderPayload({
    reminder_time: '23:59',
    timezone: 'Europe/Lisbon'
  }).ok, true);

  assert.equal(validateReminderPayload({}).error, BOTH_REQUIRED_MESSAGE);
  assert.equal(validateReminderPayload(null).error, BOTH_REQUIRED_MESSAGE);
  assert.equal(
    validateReminderPayload({ reminder_time: '24:00', timezone: 'UTC' }).error,
    REMINDER_TIME_MESSAGE
  );
  assert.equal(
    validateReminderPayload({ reminder_time: '9:00', timezone: 'UTC' }).error,
    REMINDER_TIME_MESSAGE
  );
  assert.equal(
    validateReminderPayload({ reminder_time: '23:60', timezone: 'UTC' }).error,
    REMINDER_TIME_MESSAGE
  );
  assert.equal(
    validateReminderPayload({ reminder_time: '09:05:00', timezone: 'UTC' }).error,
    REMINDER_TIME_MESSAGE
  );
  assert.equal(
    validateReminderPayload({ reminder_time: 900, timezone: 'UTC' }).error,
    REMINDER_TIME_MESSAGE
  );
  assert.equal(
    validateReminderPayload({ reminder_time: '12:00', timezone: 'Foo/Bar' }).error,
    TIMEZONE_MESSAGE
  );
  assert.equal(
    validateReminderPayload({ reminder_time: '12:00', timezone: 'America/Sao Paulo' }).error,
    TIMEZONE_MESSAGE
  );
});

test('os dois extras sao +4h e +8h, ou antes se passarem da meia-noite', () => {
  assert.deepEqual(getReminderSlots('08:00'), [
    { slot: 'main', at: '08:00', onlyWithoutCheckin: false },
    { slot: 'extra_plus_4h', at: '12:00', onlyWithoutCheckin: true },
    { slot: 'extra_plus_8h', at: '16:00', onlyWithoutCheckin: true }
  ]);

  assert.deepEqual(getReminderSlots('21:00'), [
    { slot: 'main', at: '21:00', onlyWithoutCheckin: false },
    { slot: 'extra_minus_4h', at: '17:00', onlyWithoutCheckin: true },
    { slot: 'extra_minus_8h', at: '13:00', onlyWithoutCheckin: true }
  ]);

  assert.deepEqual(getReminderSlots('19:00'), [
    { slot: 'main', at: '19:00', onlyWithoutCheckin: false },
    { slot: 'extra_plus_4h', at: '23:00', onlyWithoutCheckin: true },
    { slot: 'extra_minus_8h', at: '11:00', onlyWithoutCheckin: true }
  ]);
});

test('o lembrete principal sai mesmo quando o check-in de hoje ja existe', () => {
  const due = dueSlots({
    now: '2026-11-18T09:10:00Z',
    reminderTime: '09:00',
    timezone: 'Europe/Lisbon',
    checkedInToday: true
  });

  assert.equal(due.length, 1);
  assert.equal(due[0].slot, 'main');
  assert.equal(due[0].at, '09:00');
  assert.equal(due[0].localDate, '2026-11-18');
  assert.equal(due[0].legacy, false);
});

test('os extras ficam de fora depois do check-in e saem quando ele falta', () => {
  const instant = '2026-11-18T16:10:00Z';
  const base = {
    now: instant,
    reminderTime: '09:00',
    timezone: 'America/Sao_Paulo'
  };

  const pending = dueSlots(base);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].slot, 'extra_plus_4h');
  assert.equal(pending[0].at, '13:00');
  assert.equal(pending[0].localDate, '2026-11-18');

  const done = dueSlots({ ...base, checkedInToday: true });
  assert.deepEqual(done, []);

  const lisbon = dueSlots({ ...base, timezone: 'Europe/Lisbon' });
  assert.deepEqual(lisbon, []);
});

test('o mesmo instante respeita Europe/Lisbon e America/Sao_Paulo', () => {
  const morning = '2026-11-18T09:10:00Z';

  const lisbon = dueSlots({
    now: morning,
    reminderTime: '09:00',
    timezone: 'Europe/Lisbon'
  });
  const paulo = dueSlots({
    now: morning,
    reminderTime: '09:00',
    timezone: 'America/Sao_Paulo'
  });

  assert.equal(lisbon.length, 1);
  assert.equal(lisbon[0].slot, 'main');
  assert.equal(lisbon[0].localDate, '2026-11-18');
  assert.deepEqual(paulo, []);

  const aroundMidnight = '2026-11-18T02:30:00Z';
  const lisbonNight = dueSlots({
    now: aroundMidnight,
    reminderTime: '23:00',
    timezone: 'Europe/Lisbon',
    checkedInToday: true
  });
  const pauloNight = dueSlots({
    now: aroundMidnight,
    reminderTime: '23:00',
    timezone: 'America/Sao_Paulo',
    checkedInToday: true
  });

  assert.deepEqual(lisbonNight, []);
  assert.equal(pauloNight.length, 1);
  assert.equal(pauloNight[0].slot, 'main');
  assert.equal(pauloNight[0].at, '23:00');
  assert.equal(pauloNight[0].localDate, '2026-11-17');
});

test('a janela do slot dura 60 minutos e nao repete envio', () => {
  const open = dueSlots({
    now: '2026-11-18T09:59:00Z',
    reminderTime: '09:00',
    timezone: 'UTC'
  });
  const closed = dueSlots({
    now: '2026-11-18T10:00:00Z',
    reminderTime: '09:00',
    timezone: 'UTC'
  });
  const repeated = dueSlots({
    now: '2026-11-18T09:10:00Z',
    reminderTime: '09:00',
    timezone: 'UTC',
    alreadySent: ['main']
  });

  assert.equal(open[0].slot, 'main');
  assert.deepEqual(closed, []);
  assert.deepEqual(repeated, []);
});

test('sem missao ativa nao ha lembrete', () => {
  const due = dueSlots({
    now: '2026-11-18T09:10:00Z',
    reminderTime: '09:00',
    timezone: 'Europe/Lisbon',
    hasActiveMission: false
  });
  assert.deepEqual(due, []);
});

test('sem reminder_time o comportamento antigo permanece', () => {
  function legacy(hour, extra = {}) {
    return dueSlots({
      now: new Date(2026, 10, 18, hour, 10, 0),
      reminderTime: null,
      timezone: extra.timezone || null,
      ...extra
    });
  }

  assert.equal(legacy(13)[0].slot, 'midday_nudge');
  assert.equal(legacy(13, { missedYesterday: true })[0].slot, 'midday_recovery');
  assert.equal(legacy(20)[0].slot, 'evening_nudge');
  assert.equal(legacy(20, { missedYesterday: true })[0].slot, 'evening_recovery');
  assert.deepEqual(legacy(10), []);
  assert.deepEqual(legacy(15), []);
  assert.deepEqual(legacy(22), []);
  assert.deepEqual(legacy(13, { checkedInToday: true }), []);
  assert.deepEqual(legacy(13, { alreadySent: ['midday_nudge'] }), []);
  assert.equal(legacy(13, { timezone: 'America/Sao_Paulo' })[0].slot, 'midday_nudge');
  assert.equal(legacy(13)[0].legacy, true);
  assert.equal(legacy(13)[0].countsTowardChatLimit, false);
});

test('horario escolhido invalido nao volta para a janela antiga', () => {
  assert.deepEqual(resolveReminderSettings(null, 'Europe/Lisbon'), { mode: 'legacy' });
  assert.deepEqual(resolveReminderSettings('09:05:00', ' Europe/Lisbon '), {
    mode: 'chosen',
    clock: '09:05',
    zone: 'Europe/Lisbon'
  });
  assert.deepEqual(resolveReminderSettings('09:05', 'Foo/Bar'), { mode: 'invalid' });

  const due = dueSlots({
    now: new Date(2026, 10, 18, 13, 0, 0),
    reminderTime: 'not-a-time',
    timezone: 'Europe/Lisbon'
  });
  assert.deepEqual(due, []);
});
