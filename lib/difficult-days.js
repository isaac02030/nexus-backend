// Dias difíceis de uma missão de 30 dias.
//
// São 4 por pessoa. No máximo 2 seguidos, olhando a janela inteira: o dia novo
// não pode formar 3 seguidos com os vizinhos dos dois lados. O dia difícil não
// é falta: a pessoa ainda faz o mínimo do contrato (confirma com um toque; a
// frase é opcional), o check-in fica concluído
// e a sequência continua. Esta função só decide se o próximo dia pode ser marcado.
//
// Dias da missão: o dia difícil só existe num dia da missão. "Seguidos" são
// dias de calendário seguidos: um dia livre no meio (difícil, livre, difícil)
// quebra a sequência, como recomendou o Arquiteto. O teto de 4 continua.

const DIFFICULT_DAY_LIMIT = 4;

const DIFFICULT_LIMIT_MESSAGE = 'Você já usou os 4 dias difíceis desta missão.';
const DIFFICULT_CONSECUTIVE_MESSAGE = 'Não dá para ter mais de 2 dias difíceis seguidos.';
// O dia difícil pede só a confirmação do mínimo (minimum_done: true).
const DIFFICULT_MINIMUM_MESSAGE = 'Para marcar o dia difícil, confirme que fez o mínimo do contrato e tente de novo.';
const DIFFICULT_FREE_DAY_MESSAGE = 'Hoje é dia livre na sua missão, então não gasta dia difícil.';

function priorDifficultDays(difficultDays, dayNumber) {
  const current = Number(dayNumber);
  const days = new Set();

  for (const value of difficultDays || []) {
    const day = Number(value);
    if (!Number.isInteger(day) || day === current) continue;
    days.add(day);
  }

  return days;
}

function validateDifficultDay({ difficultDays, dayNumber, isMissionDay }) {
  if (typeof isMissionDay === 'function' && !isMissionDay(Number(dayNumber))) {
    return { ok: false, error: DIFFICULT_FREE_DAY_MESSAGE };
  }

  const prior = priorDifficultDays(difficultDays, dayNumber);

  if (prior.size >= DIFFICULT_DAY_LIMIT) {
    return { ok: false, error: DIFFICULT_LIMIT_MESSAGE };
  }

  const day = Number(dayNumber);
  const touchesThree = (
    (prior.has(day - 2) && prior.has(day - 1))
    || (prior.has(day - 1) && prior.has(day + 1))
    || (prior.has(day + 1) && prior.has(day + 2))
  );
  if (touchesThree) {
    return { ok: false, error: DIFFICULT_CONSECUTIVE_MESSAGE };
  }

  return { ok: true };
}

module.exports = {
  DIFFICULT_DAY_LIMIT,
  DIFFICULT_LIMIT_MESSAGE,
  DIFFICULT_CONSECUTIVE_MESSAGE,
  DIFFICULT_MINIMUM_MESSAGE,
  DIFFICULT_FREE_DAY_MESSAGE,
  validateDifficultDay
};
