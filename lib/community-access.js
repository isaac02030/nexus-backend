// ============================================
// NEXUS — Áreas da comunidade (decisão de 26/11: áreas, sem IA)
//
// Toda missão nova e toda comunidade têm uma área: mente, corpo ou rotina
// (lista fixa, com CHECK no banco, migração 013). Ler a comunidade é aberto;
// postar pede uma missão ATIVA da mesma área (dono ou parceiro do Duo).
// O assunto da missão (texto curto e livre) serve só para ordenar as
// comunidades recomendadas, por palavra, sem IA.
//
// A regra de postar fica aqui, num lugar só, para as próximas rotas (apoiar,
// rolar) usarem a mesma.
// ============================================

const AREAS = Object.freeze(['mente', 'corpo', 'rotina']);
const AREA_LABELS = Object.freeze({ mente: 'Mente', corpo: 'Corpo', rotina: 'Rotina' });
const SUBJECT_MAX_CHARS = 60;

// Textos novos (para o sim do dono do projeto).
const AREA_INVALID_MESSAGE = 'Escolha uma área: Mente, Corpo ou Rotina.';
const SUBJECT_NOT_TEXT_MESSAGE = 'O assunto precisa ser um texto curto, como psicologia.';
const SUBJECT_TOO_LONG_MESSAGE = `O assunto passou de ${SUBJECT_MAX_CHARS} caracteres. Encurte um pouco e envie de novo.`;

// Comunidades "só leitura / em breve": ninguém posta, todos leem.
// Decisão do dono do projeto (27/11, PR 41): a Alimentação fica só leitura
// até o filtro de crise ter uma lista de transtorno alimentar revisada por
// profissional. Para desligar, tirar 'alimentacao' daqui. Não muda o banco.
const READ_ONLY_COMMUNITY_SLUGS = ['alimentacao'];
const READ_ONLY_MESSAGE = 'Os posts aqui abrem em breve. Por enquanto, dá para ler.';

function isReadOnlyCommunity(slug, list = READ_ONLY_COMMUNITY_SLUGS) {
  return typeof slug === 'string' && list.includes(slug);
}

// Ícone da comunidade: só emoji (1 a 8 unidades de texto), nunca palavra.
// Aceita o pictograma, o seletor de variação (FE0F), o ZWJ (200D), os tons
// de pele e as bandeiras (letras regionais).
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u200D|\uFE0F|[\u{1F3FB}-\u{1F3FF}])+$/u;
function isEmojiIcon(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 8
    && EMOJI_ONLY.test(value) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

function isValidArea(value) {
  return typeof value === 'string' && AREAS.includes(value);
}

// Área do pedido de criar missão. Sem o campo: null (missão sem área, como
// antes). Com o campo: só um dos 3 valores, exatamente.
function parseArea(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isValidArea(value)) return { ok: false, error: AREA_INVALID_MESSAGE };
  return { ok: true, value };
}

// Assunto: opcional, texto, até 60 caracteres reais. Vazio vira null.
function parseSubject(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: SUBJECT_NOT_TEXT_MESSAGE };
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: true, value: null };
  if (Array.from(text).length > SUBJECT_MAX_CHARS) return { ok: false, error: SUBJECT_TOO_LONG_MESSAGE };
  return { ok: true, value: text };
}

function areaLabel(area) {
  return AREA_LABELS[area] || '';
}

// Quem pode postar. activeAreas: as áreas das missões ATIVAS da pessoa (dono
// ou parceiro). Devolve ok ou o motivo (code + texto calmo, sem culpa).
function postAccess(activeAreas, communityArea) {
  if (!isValidArea(communityArea)) {
    return {
      ok: false,
      code: 'community_without_area',
      message: 'Esta comunidade ainda não está aberta para posts.'
    };
  }
  const areas = Array.isArray(activeAreas) ? activeAreas : [];
  if (areas.includes(communityArea)) return { ok: true, code: 'ok' };
  const label = areaLabel(communityArea);
  if (areas.length === 0) {
    return {
      ok: false,
      code: 'no_active_mission',
      message: `Para postar aqui você precisa de uma missão ativa em ${label}.`
    };
  }
  const other = areas.find(isValidArea);
  if (!other) {
    return {
      ok: false,
      code: 'mission_without_area',
      message: `Sua missão ativa ainda não tem área. Para postar aqui, ela precisa ser de ${label}.`
    };
  }
  return {
    ok: false,
    code: 'other_area',
    message: `Sua missão ativa é de ${areaLabel(other)}. Esta comunidade é de ${label}.`
  };
}

// ---------- Busca simples por palavra (sem IA) ----------

const STOP_WORDS = new Set([
  'com', 'das', 'dos', 'para', 'por', 'que', 'uma', 'umas', 'uns', 'mais', 'meu', 'minha', 'sobre', 'como'
]);

// Minúsculas, sem acento, só letras e números; palavras de 3+ letras.
function words(text) {
  if (typeof text !== 'string') return [];
  const clean = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const seen = [];
  for (const word of clean.split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOP_WORDS.has(word) || seen.includes(word)) continue;
    seen.push(word);
  }
  return seen;
}

// Duas palavras "batem" se forem iguais ou se uma começa pela outra e a mais
// curta tem 4+ letras (ex.: «idioma» e «idiomas», «corrida» e «corridas»).
function wordsMatch(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

// Quantas palavras do assunto aparecem no nome, na descrição ou na categoria.
function subjectScore(subject, community) {
  const wanted = words(subject).slice(0, 8);
  if (!wanted.length || !community) return 0;
  const have = words([community.name, community.description, community.category].filter(Boolean).join(' '));
  return wanted.filter((w) => have.some((h) => wordsMatch(w, h))).length;
}

// Ordem: assunto parecido primeiro; depois as prontas, as com mais gente e o id
// (ordem sempre igual para o mesmo banco).
function rankBySubject(subject, communities) {
  return (Array.isArray(communities) ? communities : [])
    .map((c) => ({ community: c, score: subjectScore(subject, c) }))
    .sort((x, y) =>
      (y.score - x.score)
      || (Number(!!y.community.is_default) - Number(!!x.community.is_default))
      || ((Number(y.community.member_count) || 0) - (Number(x.community.member_count) || 0))
      || ((Number(x.community.id) || 0) - (Number(y.community.id) || 0)))
    .map(({ community, score }) => ({ ...community, subject_match: score > 0 }));
}

module.exports = {
  AREAS,
  AREA_LABELS,
  SUBJECT_MAX_CHARS,
  AREA_INVALID_MESSAGE,
  SUBJECT_NOT_TEXT_MESSAGE,
  SUBJECT_TOO_LONG_MESSAGE,
  READ_ONLY_COMMUNITY_SLUGS,
  READ_ONLY_MESSAGE,
  isReadOnlyCommunity,
  isEmojiIcon,
  isValidArea,
  parseArea,
  parseSubject,
  areaLabel,
  postAccess,
  words,
  subjectScore,
  rankBySubject
};
