// ============================================
// NEXUS — Lembretes separados das novidades
//
// Decisão de 22/11 (plano das lacunas legais, item 3.4). Duas escolhas
// separadas, cada uma com data e versão do texto (migração 009):
// - reminders_opt_in: lembretes da missão (push do motor de lembretes, do
//   Grande Irmão, os «cutucões», o aviso de check-in e de mensagem do par);
// - news_opt_in: novidades do Nexus (POST /api/vertice/notify-all).
// TRUE = sim, FALSE = não, NULL = ainda não escolheu. Nenhuma nasce ligada.
//
// Antes da migração 009 (as colunas não existem):
// - novidades: NENHUM envio (lado seguro);
// - lembretes da missão: seguem como antes (quem tinha o push ligado no
//   aparelho continua recebendo), para o código novo não desligar nada
//   antes da hora. Depois da 009, só quem disse sim.
// ============================================

const NOTIFICATION_CHOICE_VERSION = 'avisos-beta-1';

const PREFS_LOAD_ERROR = 'Não foi possível carregar suas escolhas de avisos. Tente de novo.';
const PREFS_SAVE_ERROR = 'Não foi possível salvar. Tente de novo.';
const PREFS_BODY_ERROR = 'Escolha não reconhecida. Toque de novo no interruptor.';

const KINDS = {
  reminders: 'reminders_opt_in',
  news: 'news_opt_in'
};

function assertAlias(alias) {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Alias inválido.');
}

// Pode mandar lembrete da missão para a linha de users com este alias?
// Sem a coluna (antes da 009): sim, como antes. Com a coluna: só TRUE.
function remindersAllowedSql(alias) {
  assertAlias(alias);
  return `(NOT (to_jsonb(${alias}) ? 'reminders_opt_in')
           OR (to_jsonb(${alias}) -> 'reminders_opt_in') = 'true'::jsonb)`;
}

// Pode mandar novidade? Só TRUE. Sem a coluna: NULL, ou seja, não.
function newsAllowedSql(alias) {
  assertAlias(alias);
  return `((to_jsonb(${alias}) -> 'news_opt_in') = 'true'::jsonb)`;
}

function allowedSqlFor(kind, alias) {
  if (kind === 'mission') return remindersAllowedSql(alias);
  if (kind === 'news') return newsAllowedSql(alias);
  throw new Error('Tipo de aviso desconhecido.');
}

const PREFS_SELECT = `to_jsonb(users) ->> 'reminders_opt_in' AS reminders,
       to_jsonb(users) ->> 'reminders_opt_in_at' AS reminders_at,
       to_jsonb(users) ->> 'news_opt_in' AS news,
       to_jsonb(users) ->> 'news_opt_in_at' AS news_at`;

function choiceLabel(value) {
  if (value === true || value === 'true') return 'yes';
  if (value === false || value === 'false') return 'no';
  return null;
}

function isoOrNull(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function prefsPayload(row) {
  const one = (choice, at) => {
    const label = choiceLabel(choice);
    return { choice: label, decided_at: label ? isoOrNull(at) : null };
  };
  return {
    reminders: one(row && row.reminders, row && row.reminders_at),
    news: one(row && row.news, row && row.news_at)
  };
}

// Corpo do PUT: { reminders?: boolean, news?: boolean }, ao menos um.
// Só true/false de verdade; nada mais liga um aviso.
function parsePrefsBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const changes = {};
  for (const key of Object.keys(body)) {
    if (!(key in KINDS)) return null;
    if (typeof body[key] !== 'boolean') return null;
    changes[key] = body[key];
  }
  return Object.keys(changes).length ? changes : null;
}

module.exports = {
  NOTIFICATION_CHOICE_VERSION,
  PREFS_LOAD_ERROR,
  PREFS_SAVE_ERROR,
  PREFS_BODY_ERROR,
  KINDS,
  PREFS_SELECT,
  allowedSqlFor,
  newsAllowedSql,
  parsePrefsBody,
  prefsPayload,
  remindersAllowedSql
};
