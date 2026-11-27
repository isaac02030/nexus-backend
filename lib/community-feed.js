// ============================================
// NEXUS — Lista de posts da comunidade: cursor, página e "dia cumprido"
// (PR C da comunidade; spec da Clara, seção 3).
//
// - Cursor = o created_at do post (texto do próprio Postgres, com os
//   microssegundos) + o id. Opaco para o site (base64url). Nunca OFFSET.
// - Página: 10 posts («Ver anteriores» de 10 em 10). Quem cumpriu o dia de
//   hoje ganha a rolagem contínua (continuous_scroll) e páginas de 20.
// - "Dia cumprido": o mesmo dia do check-in (lib/mission-days, no fuso da
//   pessoa, que no beta é Europe/Lisbon). Vale se, numa missão ativa, o dia
//   de hoje tem check-in feito (o dia difícil também é check-in feito) ou é
//   dia livre. Sem missão ativa: não cumprido.
// ============================================

const { missionDayContextFor } = require('./mission-days');

const PAGE_SIZE = 10;
const CONTINUOUS_PAGE_SIZE = 20;
const HIGHLIGHTS_MAX = 3;
const HIGHLIGHTS_DAYS = 7;

// created_at como o Postgres escreve um TIMESTAMP em texto (com ou sem fração).
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

function encodeCursor(createdAtText, id) {
  if (typeof createdAtText !== 'string' || !CURSOR_TIME.test(createdAtText)) return null;
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  return Buffer.from(`${createdAtText}|${n}`, 'utf8').toString('base64url');
}

// Devolve { createdAt, id } ou null se o cursor não for nosso.
function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 80 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const match = /^([^|]+)\|([1-9]\d{0,9})$/.exec(text);
  if (!match || !CURSOR_TIME.test(match[1])) return null;
  const id = Number(match[2]);
  if (id > 2147483647) return null;
  return { createdAt: match[1], id };
}

// missions: as missões ATIVAS da pessoa (com started_at e mission_weekdays).
// doneDays: Map missionId -> Set de day_number com check-in feito.
function dayDone(missions, clock, doneDays, now = new Date()) {
  for (const mission of Array.isArray(missions) ? missions : []) {
    if (!mission || !mission.started_at) continue;
    const ctx = missionDayContextFor(mission, clock?.reminder_time, clock?.timezone, now);
    const day = ctx.dayNumber;
    if (!Number.isInteger(day) || day < 1) continue;
    if (!ctx.isMissionDay(day)) return true; // dia livre vale como cumprido
    const done = doneDays && doneDays.get(Number(mission.id));
    if (done && done.has(day)) return true;
  }
  return false;
}

module.exports = {
  PAGE_SIZE,
  CONTINUOUS_PAGE_SIZE,
  HIGHLIGHTS_MAX,
  HIGHLIGHTS_DAYS,
  encodeCursor,
  decodeCursor,
  dayDone
};
