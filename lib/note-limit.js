// Limite da frase (nota) do check-in e do dia difícil.
//
// 280 caracteres reais: conta cada letra ou emoji como 1 (code point),
// não os bytes. O filtro de crise roda antes deste limite: uma nota com
// crise não chega aqui (é descartada antes) e a pessoa vê a ajuda.

const NOTE_MAX_CHARS = 280;

const NOTE_TOO_LONG_MESSAGE = `A frase passou de ${NOTE_MAX_CHARS} caracteres. Encurte um pouco e envie de novo.`;
const NOTE_NOT_TEXT_MESSAGE = 'A frase precisa ser um texto. Escreva de novo e envie.';

function noteLength(note) {
  return [...note].length;
}

// Devolve a mensagem de erro, ou null se a nota pode seguir.
// Sem nota (ausente ou null) é permitido: a frase é opcional em vários casos.
function validateNoteLimit(note) {
  if (note == null) return null;
  if (typeof note !== 'string') return NOTE_NOT_TEXT_MESSAGE;
  if (noteLength(note) > NOTE_MAX_CHARS) return NOTE_TOO_LONG_MESSAGE;
  return null;
}

module.exports = {
  NOTE_MAX_CHARS,
  NOTE_TOO_LONG_MESSAGE,
  NOTE_NOT_TEXT_MESSAGE,
  noteLength,
  validateNoteLimit
};
