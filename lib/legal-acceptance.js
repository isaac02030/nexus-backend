// ============================================
// NEXUS — Aceite dos Termos de uso e da Política de privacidade
//
// Decisão de 22/11 (plano das lacunas legais, item 3.3): o aceite é
// obrigatório no cadastro e fica guardado com a versão e a hora do
// SERVIDOR (migração 008). Quando a versão atual muda, a pessoa precisa
// aceitar de novo (POST /api/users/me/legal-acceptance).
//
// O servidor só aceita a versão ATUAL de cada texto (constantes abaixo).
// A tela manda as versões que mostrou; versão antiga, vazia ou de outro
// tipo = 400, e nada é gravado.
// ============================================

// Versões vigentes (rascunho beta-1 dos textos legais). Ao publicar texto
// novo, sobe aqui: quem aceitou a versão anterior passa a ver
// needs_acceptance: true e precisa aceitar de novo.
const CURRENT_TERMS_VERSION = 'beta-1';
const CURRENT_PRIVACY_VERSION = 'beta-1';

const LEGAL_ACCEPTANCE_REQUIRED_MESSAGE =
  'Para criar a conta, marque que você leu e aceita os termos e a política de privacidade.';
const LEGAL_REACCEPT_REQUIRED_MESSAGE =
  'Para continuar, marque que você leu e aceita os termos e a política de privacidade.';
const LEGAL_VERSION_OUTDATED_MESSAGE =
  'Os termos ou a política de privacidade mudaram. Recarregue a página para ver a versão atual e aceite de novo.';
const LEGAL_SAVE_ERROR_MESSAGE = 'Não foi possível guardar seu aceite. Tente de novo.';

// Confere as versões que vieram no corpo do pedido.
// ok: true só quando as duas são exatamente as atuais.
function checkAcceptance(body, { reaccept = false } = {}) {
  const terms = body ? body.terms_version : undefined;
  const privacy = body ? body.privacy_version : undefined;
  const missing = (value) => typeof value !== 'string' || value.trim() === '';
  if (missing(terms) || missing(privacy)) {
    return {
      ok: false,
      status: 400,
      error: reaccept ? LEGAL_REACCEPT_REQUIRED_MESSAGE : LEGAL_ACCEPTANCE_REQUIRED_MESSAGE,
      code: 'legal_acceptance_required'
    };
  }
  if (terms !== CURRENT_TERMS_VERSION || privacy !== CURRENT_PRIVACY_VERSION) {
    return {
      ok: false,
      status: 400,
      error: LEGAL_VERSION_OUTDATED_MESSAGE,
      code: 'legal_version_outdated',
      current_terms_version: CURRENT_TERMS_VERSION,
      current_privacy_version: CURRENT_PRIVACY_VERSION
    };
  }
  return { ok: true, terms: CURRENT_TERMS_VERSION, privacy: CURRENT_PRIVACY_VERSION };
}

function errorBody(check) {
  const body = { error: check.error, code: check.code };
  if (check.current_terms_version) {
    body.current_terms_version = check.current_terms_version;
    body.current_privacy_version = check.current_privacy_version;
  }
  return body;
}

// Lê as colunas da 008 sem quebrar antes da migração (to_jsonb).
const LEGAL_SELECT = `to_jsonb(users) ->> 'terms_version' AS terms_version,
       to_jsonb(users) ->> 'terms_accepted_at' AS terms_accepted_at,
       to_jsonb(users) ->> 'privacy_version' AS privacy_version,
       to_jsonb(users) ->> 'privacy_accepted_at' AS privacy_accepted_at`;

function isoOrNull(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// O que o site precisa para saber se mostra a tela de reaceitação.
// Sem registro (conta antiga ou antes da migração 008): needs_acceptance.
function legalStatus(row) {
  const terms = row && row.terms_version ? String(row.terms_version) : null;
  const privacy = row && row.privacy_version ? String(row.privacy_version) : null;
  return {
    terms_version: terms,
    terms_accepted_at: terms ? isoOrNull(row.terms_accepted_at) : null,
    privacy_version: privacy,
    privacy_accepted_at: privacy ? isoOrNull(row.privacy_accepted_at) : null,
    current_terms_version: CURRENT_TERMS_VERSION,
    current_privacy_version: CURRENT_PRIVACY_VERSION,
    needs_acceptance: terms !== CURRENT_TERMS_VERSION || privacy !== CURRENT_PRIVACY_VERSION
  };
}

module.exports = {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_VERSION,
  LEGAL_ACCEPTANCE_REQUIRED_MESSAGE,
  LEGAL_REACCEPT_REQUIRED_MESSAGE,
  LEGAL_VERSION_OUTDATED_MESSAGE,
  LEGAL_SAVE_ERROR_MESSAGE,
  LEGAL_SELECT,
  checkAcceptance,
  errorBody,
  legalStatus
};
