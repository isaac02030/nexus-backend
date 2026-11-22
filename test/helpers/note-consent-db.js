// Ajuda dos testes: o check-in lê o consentimento da nota (lib/note-consent.js)
// dentro da transação. Os testes antigos de check-in tratam da nota GRAVADA,
// então respondem "sim" a essa consulta; os casos sem consentimento ficam em
// test/note-consent.test.js.
const NOTE_CONSENT_SQL = /to_jsonb\(users\) -> 'note_consent'/;

function consentRows(granted) {
  return {
    rows: [{
      granted: granted === true,
      choice: granted == null ? null : String(granted),
      decided_at: granted == null ? null : '2026-11-22T12:00:00+00:00',
      version: granted == null ? null : 'nota-beta-1'
    }],
    rowCount: 1
  };
}

module.exports = { NOTE_CONSENT_SQL, consentRows };
