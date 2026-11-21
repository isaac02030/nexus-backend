// ============================================
// NEXUS — Denúncia de posts da comunidade
//
// Regras:
// - Só membro da comunidade denuncia, uma vez por post (chave única no banco).
// - O motivo vem de uma lista curta. O texto livre é opcional, tem o mesmo
//   limite da frase do check-in (280) e passa pelo filtro de crise. Se o
//   filtro dispara, a denúncia vale, mas o texto NÃO é guardado nem logado.
// - Com HIDE_AFTER_REPORTS denúncias de pessoas diferentes, o post fica
//   escondido (não é apagado) até o admin conferir. Motivo "perigoso"
//   (conselho perigoso para a saúde) esconde já na 1.ª denúncia, até 3 por
//   pessoa a cada 24 horas, e o post vai para o topo da lista do admin. Depois de restaurado, só contam as
//   denúncias feitas depois da restauração.
// ============================================

// 3 pessoas diferentes. No beta as comunidades são pequenas (poucos testers
// por nicho): com 2, dois amigos escondem qualquer post; com 5 ou mais, um
// post ruim pode nunca chegar ao número. Mesmo número do plano do Arquiteto.
const HIDE_AFTER_REPORTS = 3;

// Esconde com 1 denúncia e tem prioridade na lista do admin.
const URGENT_REASON = 'perigoso';

// Salvaguardas contra abuso do "perigoso" (não mudam a regra):
// - cada pessoa tem no máximo 3 denúncias "perigoso" que escondem sozinhas
//   a cada 24 horas; da 4.ª em diante, a denúncia vale como comum (entra
//   nas 3 pessoas), não se perde;
// - na lista do admin, alerta quando alguém que ajudou a esconder o post
//   escondeu 2 ou mais posts nas últimas 24 horas (sem dizer quem).
const FAST_TRACK_PER_DAY = 3;
const REPEAT_ALERT_POSTS = 2;

// Ordem = gravidade. No empate de votos, vale o motivo que vem primeiro.
const REPORT_REASONS = [
  { code: 'perigoso', label: 'Conselho perigoso para a saúde' },
  { code: 'ofensa', label: 'Ofensa ou ataque a alguém' },
  { code: 'improprio', label: 'Conteúdo impróprio (sexual ou violento)' },
  { code: 'spam', label: 'Propaganda ou spam' },
  { code: 'outro', label: 'Outro motivo' }
];

const REASON_CODES = REPORT_REASONS.map((r) => r.code);

function isValidReason(code) {
  return typeof code === 'string' && REASON_CODES.includes(code);
}

function reasonLabel(code) {
  const found = REPORT_REASONS.find((r) => r.code === code);
  return found ? found.label : null;
}

// rows: [{ reason, fast_track, total }]. Com alguma denúncia "perigoso"
// que esconde sozinha, o motivo é "perigoso". Senão, o motivo com mais
// votos; no empate, o mais grave.
function pickHiddenReason(rows) {
  if (urgentCount(rows) > 0) return URGENT_REASON;
  let best = null;
  let bestTotal = 0;
  for (const code of REASON_CODES) {
    const total = rows
      .filter((r) => r.reason === code)
      .reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    if (total > bestTotal) {
      best = code;
      bestTotal = total;
    }
  }
  return best;
}

function countReports(rows) {
  return rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
}

// Denúncias "perigoso" que escondem sozinhas (dentro da cota de 3 por dia).
function urgentCount(rows) {
  return rows
    .filter((r) => r.reason === URGENT_REASON && r.fast_track === true)
    .reduce((sum, r) => sum + (Number(r.total) || 0), 0);
}

// Esconde com 3 pessoas diferentes, ou com 1 denúncia "perigoso" dentro da cota.
function shouldHide(rows) {
  return urgentCount(rows) >= 1 || countReports(rows) >= HIDE_AFTER_REPORTS;
}

function hiddenMessage(code) {
  const label = reasonLabel(code);
  const motivo = label ? ` Motivo mais citado: ${label.toLowerCase()}.` : '';
  return `Seu post foi escondido depois de algumas denúncias.${motivo} Ele não foi apagado: a equipe do Nexus vai conferir.`;
}

module.exports = {
  HIDE_AFTER_REPORTS,
  URGENT_REASON,
  FAST_TRACK_PER_DAY,
  REPEAT_ALERT_POSTS,
  REPORT_REASONS,
  REASON_CODES,
  isValidReason,
  reasonLabel,
  pickHiddenReason,
  countReports,
  shouldHide,
  hiddenMessage
};
