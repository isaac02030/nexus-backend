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
//   (conselho perigoso para a saúde) esconde já na 1.ª denúncia e o post
//   vai para o topo da lista do admin. Depois de restaurado, só contam as
//   denúncias feitas depois da restauração.
// ============================================

// 3 pessoas diferentes. No beta as comunidades são pequenas (poucos testers
// por nicho): com 2, dois amigos escondem qualquer post; com 5 ou mais, um
// post ruim pode nunca chegar ao número. Mesmo número do plano do Arquiteto.
const HIDE_AFTER_REPORTS = 3;

// Esconde com 1 denúncia e tem prioridade na lista do admin.
const URGENT_REASON = 'perigoso';

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

// rows: [{ reason, total }]. Com alguma denúncia "perigoso", o motivo é
// "perigoso". Senão, o motivo com mais votos; no empate, o mais grave.
function pickHiddenReason(rows) {
  if (urgentCount(rows) > 0) return URGENT_REASON;
  let best = null;
  let bestTotal = 0;
  for (const code of REASON_CODES) {
    const row = rows.find((r) => r.reason === code);
    const total = row ? Number(row.total) || 0 : 0;
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

function urgentCount(rows) {
  const row = rows.find((r) => r.reason === URGENT_REASON);
  return row ? Number(row.total) || 0 : 0;
}

// Esconde com 3 pessoas diferentes, ou com 1 denúncia "perigoso".
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
  REPORT_REASONS,
  REASON_CODES,
  isValidReason,
  reasonLabel,
  pickHiddenReason,
  countReports,
  shouldHide,
  hiddenMessage
};
