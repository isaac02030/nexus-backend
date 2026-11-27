// ============================================
// NEXUS — Mérito na comunidade (decisão de 27/11: títulos, opção A)
//
// Conta SÓ as missões pessoais (tabela missions) de 30 dias ou mais,
// CONCLUÍDAS, em que a pessoa é dona ou parceira do Duo. Missão curta,
// ativa, abandonada ou da Maratona (community_missions) não conta.
// Calculado na leitura: sem tabela nova e sem número guardado que fique velho.
// ============================================

const { ownOrDuoMissionSql } = require('./mission-participation');

const MERIT_MIN_DAYS = 30;

// Títulos (nome e quantas missões). O símbolo é a fita de 5 marcas: o nível
// diz quantas acendem.
const TITLES = Object.freeze([
  Object.freeze({ name: 'Iniciante', min: 1, level: 1 }),
  Object.freeze({ name: 'Praticante', min: 3, level: 2 }),
  Object.freeze({ name: 'Constante', min: 6, level: 3 }),
  Object.freeze({ name: 'Veterano', min: 12, level: 4 }),
  Object.freeze({ name: 'Referência', min: 24, level: 5 })
]);
const TITLE_MARKS = 5;

const MERIT_RULE = 'Vale o número de missões. No empate, o tempo na comunidade.';

// A missão "mm" conta para a pessoa de userColumn? userColumn é sempre um
// nome fixo do código (nunca vem do pedido).
// Dona: sempre. Parceira (partner_id): só no Duo de verdade, na MESMA
// missão. No Rival (mode = 'rival', convite do PR 38) e em qualquer par por
// mission_matches, cada um tem a sua missão e o partner_id aponta para o
// outro: contar ali somaria a missão do outro (achado do Argos no PR 44).
// A regra de quem participa fica em lib/mission-participation.js.
function meritConditionSql(userColumn) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(userColumn)) throw new Error('coluna inválida');
  return `${ownOrDuoMissionSql(userColumn, 'mm')}
           AND mm.status = 'completed'
           AND mm.duration_days >= ${MERIT_MIN_DAYS}`;
}

// Quantas missões contam, como subconsulta (uma pessoa por linha).
function meritCountSql(userColumn) {
  return `(SELECT COUNT(*)::int FROM missions mm WHERE ${meritConditionSql(userColumn)})`;
}

function toCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// O título de quem tem n missões, ou null (ainda sem título).
function titleFor(missions) {
  const n = toCount(missions);
  let found = null;
  for (const t of TITLES) if (n >= t.min) found = t;
  return found ? { name: found.name, level: found.level, marks: TITLE_MARKS } : null;
}

// O próximo título e quanto falta, ou null no topo.
function nextTitle(missions) {
  const n = toCount(missions);
  const next = TITLES.find((t) => t.min > n);
  return next ? { name: next.name, missions: next.min, missing: next.min - n } : null;
}

module.exports = {
  MERIT_MIN_DAYS,
  TITLES,
  TITLE_MARKS,
  MERIT_RULE,
  meritConditionSql,
  meritCountSql,
  titleFor,
  nextTitle
};
