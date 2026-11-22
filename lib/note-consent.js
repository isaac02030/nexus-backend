// ============================================
// NEXUS — Consentimento para guardar a nota do check-in
//
// Decisão de 22/11 (pacote legal, item 1): a nota livre do check-in só é
// gravada com um "sim" explícito e separado. Sem resposta, ou com "não",
// o check-in funciona igual e a nota NÃO é gravada (o servidor usa o texto
// só para o filtro de crise e para a regra de tamanho/prova, sem guardar).
//
// Guarda a última escolha em users (migração 007): note_consent,
// note_consent_at (hora do servidor) e note_consent_version.
// Antes da migração aplicada, to_jsonb(users) devolve NULL para essas
// colunas: vale "não respondeu" e nenhuma nota é gravada (lado seguro).
// ============================================

// Versão do texto do consentimento que a tela mostra (legal/ do conselho,
// rascunho beta-1). Sobe quando o texto mudar.
const NOTE_CONSENT_VERSION = 'nota-beta-1';

const NOTE_CONSENT_LOAD_ERROR = 'Não foi possível carregar sua escolha sobre as notas. Tente de novo.';
const NOTE_CONSENT_SAVE_ERROR = 'Não foi possível guardar sua escolha. Tente de novo.';
const NOTE_CONSENT_BODY_ERROR = 'Escolha não reconhecida. Toque de novo em «Sim, guardar minhas notas».';

// Lê a escolha sem quebrar antes da migração 007 (to_jsonb).
// lock = 'share' trava a linha da pessoa até o fim da transação, para uma
// retirada ao mesmo tempo não deixar uma nota nova para trás.
function consentSelectSql(lock) {
  return `SELECT (to_jsonb(users) -> 'note_consent') = 'true'::jsonb AS granted,
                 to_jsonb(users) ->> 'note_consent' AS choice,
                 to_jsonb(users) ->> 'note_consent_at' AS decided_at,
                 to_jsonb(users) ->> 'note_consent_version' AS version
          FROM users
          WHERE id = $1${lock === 'share' ? '\n          FOR SHARE' : ''}`;
}

function choiceLabel(value) {
  if (value === true || value === 'true') return 'yes';
  if (value === false || value === 'false') return 'no';
  return null;
}

function consentPayload(row) {
  const choice = choiceLabel(row ? row.choice : null);
  return {
    note_consent: choice,
    decided_at: choice && row.decided_at ? new Date(row.decided_at).toISOString() : null,
    version: choice ? (row.version || null) : null
  };
}

// Só TRUE grava. NULL (não respondeu), FALSE e qualquer outra coisa: não.
async function notesAllowed(executor, userId, { lock } = {}) {
  const result = await executor.query(consentSelectSql(lock), [userId]);
  return Boolean(result.rows[0] && result.rows[0].granted === true);
}

module.exports = {
  NOTE_CONSENT_VERSION,
  NOTE_CONSENT_LOAD_ERROR,
  NOTE_CONSENT_SAVE_ERROR,
  NOTE_CONSENT_BODY_ERROR,
  consentSelectSql,
  consentPayload,
  notesAllowed
};
