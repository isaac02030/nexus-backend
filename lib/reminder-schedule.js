// Decide quais lembretes estao na hora.
//
// Padrao para confirmar com o dono do projeto:
// - O horario escolhido e o lembrete principal. Ele sai sempre que a missao
//   esta ativa, mesmo se a pessoa ja fez o check-in de hoje.
// - Ha dois extras, 4 horas e 8 horas depois desse horario. Cada um so sai se
//   o check-in de hoje (no fuso da pessoa) ainda nao foi feito.
// - Se a conta cair no dia seguinte, o mesmo intervalo fica ANTES do horario
//   escolhido, para o extra continuar no dia de hoje.
// - Quem nao tem reminder_time continua nas janelas antigas do relogio do
//   servidor: 12:00-14:59 e 19:00-21:59, e so sem check-in.
//
// O scheduler olha a cada 15 minutos. Um slot fica devido desde o minuto
// escolhido ate 60 minutos depois, sem atravessar a meia-noite.
// Nenhum destes avisos conta no limite de chat: o resultado marca
// countsTowardChatLimit = false e o envio e so push.

const EXTRA_OFFSET_HOURS = [4, 8];
const SLOT_WINDOW_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;

const REMINDER_TIME_MESSAGE = 'Informe o horário no formato HH:MM, de 00:00 a 23:59.';
const TIMEZONE_MESSAGE = 'Fuso horário inválido. Exemplo válido: America/Sao_Paulo.';
const BOTH_REQUIRED_MESSAGE = 'Informe o horário (HH:MM) e o fuso horário.';

// "Hoje" no fuso da pessoa. created_at e timestamp sem fuso: lemos o relogio
// da sessao do banco e convertemos para o fuso IANA guardado.
const CHECKED_IN_ON_LOCAL_DATE_SQL = `
  SELECT 1
  FROM checkins
  WHERE mission_id = $1
    AND user_id = $2
    AND completed = true
    AND (((created_at AT TIME ZONE current_setting('TIMEZONE')) AT TIME ZONE $3)::date) = $4::date
  LIMIT 1
`;

function canonicalTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return null;
  const trimmed = timeZone.trim();
  if (!trimmed || trimmed.length > 100) return null;

  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
    if (!canonical || canonical.length > 100) return null;
    return canonical;
  } catch (err) {
    return null;
  }
}

function normalizeClock(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

function reminderTimeIsSet(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function clockToMinutes(clock) {
  const [hour, minute] = clock.split(':').map(Number);
  return hour * 60 + minute;
}

function formatMinutes(total) {
  const minutes = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildSlots(clock) {
  const chosen = clockToMinutes(clock);
  const slots = [
    { slot: 'main', minutes: chosen, onlyWithoutCheckin: false }
  ];

  for (const hours of EXTRA_OFFSET_HOURS) {
    const offset = hours * 60;
    const crossesMidnight = chosen + offset >= MINUTES_PER_DAY;
    slots.push({
      slot: crossesMidnight ? `extra_minus_${hours}h` : `extra_plus_${hours}h`,
      minutes: crossesMidnight ? chosen - offset : chosen + offset,
      onlyWithoutCheckin: true
    });
  }

  return slots;
}

function getReminderSlots(reminderTime) {
  const clock = normalizeClock(reminderTime);
  if (!clock) return [];

  return buildSlots(clock).map(slot => ({
    slot: slot.slot,
    at: formatMinutes(slot.minutes),
    onlyWithoutCheckin: slot.onlyWithoutCheckin
  }));
}

function toInstant(now) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) return null;
  return instant;
}

function getZonedParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;

  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');

  return {
    hour,
    minute: Number(parts.minute),
    dateKey: `${year}-${month}-${day}`
  };
}

function getLocalDateKey(now, timeZone) {
  const zone = canonicalTimeZone(timeZone);
  const instant = toInstant(now);
  if (!zone || !instant) return null;
  return getZonedParts(instant, zone).dateKey;
}

function resolveReminderSettings(reminderTime, timezone) {
  if (!reminderTimeIsSet(reminderTime)) return { mode: 'legacy' };

  const clock = normalizeClock(typeof reminderTime === 'string' ? reminderTime : String(reminderTime));
  const zone = canonicalTimeZone(timezone);
  if (!clock || !zone) return { mode: 'invalid' };

  return { mode: 'chosen', clock, zone };
}

function getLegacyReminderKind(instant, missedYesterday) {
  const hour = instant.getHours();

  if (hour >= 12 && hour < 15) {
    return missedYesterday ? 'midday_recovery' : 'midday_nudge';
  }

  if (hour >= 19 && hour < 22) {
    return missedYesterday ? 'evening_recovery' : 'evening_nudge';
  }

  return null;
}

function isInSlotWindow(currentMinutes, slotMinutes) {
  const end = Math.min(slotMinutes + SLOT_WINDOW_MINUTES, MINUTES_PER_DAY);
  return currentMinutes >= slotMinutes && currentMinutes < end;
}

function reminderResult(fields) {
  return {
    slot: fields.slot,
    at: fields.at,
    localDate: fields.localDate,
    legacy: fields.legacy,
    countsTowardChatLimit: false
  };
}

function getDueReminders({
  now,
  reminderTime = null,
  timezone = null,
  hasActiveMission = false,
  checkedInToday = false,
  missedYesterday = false,
  alreadySent = []
} = {}) {
  if (hasActiveMission !== true) return [];

  const instant = toInstant(now);
  if (!instant) return [];

  const sent = new Set(Array.isArray(alreadySent) ? alreadySent : []);
  const settings = resolveReminderSettings(reminderTime, timezone);
  if (settings.mode === 'invalid') return [];

  if (settings.mode === 'legacy') {
    if (checkedInToday === true) return [];
    const kind = getLegacyReminderKind(instant, missedYesterday);
    if (!kind || sent.has(kind)) return [];
    return [reminderResult({ slot: kind, at: null, localDate: null, legacy: true })];
  }

  const zoned = getZonedParts(instant, settings.zone);
  const currentMinutes = zoned.hour * 60 + zoned.minute;
  const due = [];

  for (const slot of buildSlots(settings.clock)) {
    if (sent.has(slot.slot)) continue;
    if (slot.onlyWithoutCheckin && checkedInToday === true) continue;
    if (!isInSlotWindow(currentMinutes, slot.minutes)) continue;

    due.push(reminderResult({
      slot: slot.slot,
      at: formatMinutes(slot.minutes),
      localDate: zoned.dateKey,
      legacy: false
    }));
  }

  due.sort((a, b) => a.at.localeCompare(b.at) || a.slot.localeCompare(b.slot));
  return due;
}

function validateReminderPayload(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const timeRaw = typeof source.reminder_time === 'string' ? source.reminder_time.trim() : '';
  const zoneRaw = typeof source.timezone === 'string' ? source.timezone.trim() : '';

  if (!timeRaw && !zoneRaw) {
    return { ok: false, error: BOTH_REQUIRED_MESSAGE };
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeRaw)) {
    return { ok: false, error: REMINDER_TIME_MESSAGE };
  }

  const zone = canonicalTimeZone(zoneRaw);
  if (!zone) {
    return { ok: false, error: TIMEZONE_MESSAGE };
  }

  return {
    ok: true,
    value: {
      reminder_time: timeRaw,
      timezone: zone
    }
  };
}

module.exports = {
  EXTRA_OFFSET_HOURS,
  SLOT_WINDOW_MINUTES,
  REMINDER_TIME_MESSAGE,
  TIMEZONE_MESSAGE,
  BOTH_REQUIRED_MESSAGE,
  CHECKED_IN_ON_LOCAL_DATE_SQL,
  validateReminderPayload,
  getReminderSlots,
  getLocalDateKey,
  resolveReminderSettings,
  getDueReminders
};
