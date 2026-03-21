// ============================================
// NEXUS — VÉRTICE
// Sistema de mensagens contextuais
// Calmo. Observador. Preciso.
// ============================================

// Banco de mensagens por contexto
const MESSAGES = {

  // SOLO / FILA DE ESPERA
  solo: {
    day_1: [
      "Dia 1. Começa.",
      "O primeiro dia define o padrão.",
      "Dia 1. O resto vem depois."
    ],
    day_n: [
      "Dia {n}. Manténs.",
      "Dia {n}.",
      "Dia {n}. Continua.",
      "Dia {n}. A sequência está intacta."
    ],
    good_streak: [
      "{n} dias seguidos. Continua.",
      "{n} dias. Não pares agora.",
      "Sequência de {n}. Raros chegam aqui."
    ],
    failed: [
      "Hoje falhaste. Amanhã é o que importa.",
      "A sequência quebrou. Recomeça amanhã.",
      "Um dia perdido. Só um.",
      "Hoje falhaste."
    ],
    waiting: [
      "Ainda sem parceiro. A missão não espera.",
      "Estás sozinho. Por enquanto.",
      "Sem match ainda. Continua.",
      "A espera não é pausa. É tempo."
    ],
    reminder: [
      "O check-in de hoje ainda não foi feito.",
      "Dia {n}. Estás a atrasar.",
      "Ainda a tempo. Por pouco.",
      "Estás a atrasar."
    ]
  },

  // MODO RIVAL
  rival: {
    rival_done_you_not: [
      "Ele já fez check-in.",
      "O teu rival fez check-in. Tu não.",
      "Ele não esperou. Tu ainda estás a tempo.",
      "Já foi. Tu ainda não."
    ],
    you_done_rival_not: [
      "Fizeste o check-in. Ele ainda não.",
      "Estás à frente. Por hoje.",
      "Ganhaste o dia. Amanhã recomeça.",
      "O dia foi teu."
    ],
    both_done: [
      "Ambos fizeram check-in. Empate no dia.",
      "Dia {n} para os dois.",
      "Nenhum cedeu hoje."
    ],
    none_done: [
      "Nenhum dos dois fez check-in.",
      "O dia ainda não começou para nenhum.",
      "Quem vai primeiro?"
    ],
    winning: [
      "{score} a {rival_score}. Mantém.",
      "Estás à frente. Não relaxes.",
      "{diff} dias de vantagem. Continua."
    ],
    losing: [
      "{rival_score} a {score}. A diferença é {diff} dia.",
      "Estás atrás. Ainda dá para recuperar.",
      "Ele ganhou {diff} dias. Tu podes ganhar de volta."
    ],
    draw: [
      "{score} a {score}. Empate.",
      "Estão iguais. O próximo check-in decide.",
      "A diferença é zero. Por agora."
    ],
    reminder: [
      "Vai deixar o teu rival ganhar hoje?",
      "Ele já fez. Tu não.",
      "O rival não parou. Tu?"
    ]
  },

  // MODO PARCEIRO
  partner: {
    partner_done_you_not: [
      "O teu parceiro fez check-in. Falta o teu.",
      "Ele não faltou. Tu?",
      "O teu parceiro está à espera do teu check-in.",
      "Não deixes o teu parceiro sozinho."
    ],
    you_done_partner_not: [
      "Fizeste o teu. Falta o teu parceiro.",
      "Estás feito. O teu parceiro ainda não.",
      "A tua parte está feita."
    ],
    both_done: [
      "Dia {n} completo para os dois.",
      "Ambos fizeram. Assim se constrói.",
      "Nenhum falhou hoje."
    ],
    none_done: [
      "Nenhum dos dois fez check-in ainda.",
      "O dia está a passar."
    ],
    reminder: [
      "Não deixes o teu parceiro na mão.",
      "O teu parceiro conta contigo.",
      "Ele está à espera do teu check-in."
    ]
  },

  // MARATONA
  marathon: {
    position: [
      "Estás em {pos}º lugar.",
      "Posição {pos}. Há {ahead} à tua frente.",
      "{pos}º. A maratona não para."
    ],
    top3: [
      "Estás no top 3. Mantém.",
      "{pos}º lugar. Poucos chegam aqui.",
      "Top 3. Não cedas agora."
    ],
    reminder: [
      "{ahead} pessoas à tua frente fizeram check-in hoje.",
      "A maratona não para. Tu?",
      "O ranking está a mudar. Faz o teu check-in."
    ],
    completed: [
      "Maratona concluída. {pos}º lugar final.",
      "Terminaste em {pos}º. A próxima começa quando quiseres."
    ]
  },

  // CONQUISTAS
  milestones: {
    day_7:  ["7 dias. Uma semana inteira.", "Semana 1 completa."],
    day_14: ["Metade do caminho.", "Dia 14. A meio."],
    day_21: ["21 dias. O hábito começa a formar-se.", "3 semanas. Continua."],
    day_30: ["30 dias. Missão completa.", "Chegaste ao fim. Poucos chegam."]
  }
};

// ============================================
// ESCOLHER MENSAGEM CERTA PARA O CONTEXTO
// ============================================
function getMessage(category, key, vars = {}) {
  const pool = MESSAGES[category]?.[key];
  if (!pool || pool.length === 0) return null;

  // Escolher mensagem aleatória do pool
  let msg = pool[Math.floor(Math.random() * pool.length)];

  // Substituir variáveis
  Object.entries(vars).forEach(([k, v]) => {
    msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  });

  return msg;
}

// ============================================
// GERAR MENSAGEM PARA NOTIFICAÇÃO
// Recebe contexto da missão e devolve título + corpo
// ============================================
function generateNotification(context) {
  const { mode, dayNumber, streak, userScore, partnerScore,
          rivalDoneToday, partnerDoneToday, userDoneToday,
          position, aheadCount, isWaiting } = context;

  let title = 'VÉRTICE';
  let body  = '';

  // Marco especial
  if ([7, 14, 21, 30].includes(dayNumber) && userDoneToday) {
    const key = `day_${dayNumber}`;
    body = getMessage('milestones', key) || `Dia ${dayNumber}.`;
    return { title, body };
  }

  if (mode === 'solo' || isWaiting) {
    if (isWaiting) {
      body = getMessage('solo', 'waiting');
    } else if (!userDoneToday) {
      body = getMessage('solo', 'reminder', { n: dayNumber });
    } else if (streak >= 3) {
      body = getMessage('solo', 'good_streak', { n: streak });
    } else {
      body = getMessage('solo', 'day_n', { n: dayNumber });
    }

  } else if (mode === 'rival') {
    if (!userDoneToday && rivalDoneToday) {
      body = getMessage('rival', 'rival_done_you_not');
    } else if (userDoneToday && !rivalDoneToday) {
      body = getMessage('rival', 'you_done_rival_not');
    } else if (!userDoneToday && !rivalDoneToday) {
      body = getMessage('rival', 'reminder');
    } else {
      const diff = Math.abs(userScore - partnerScore);
      if (userScore > partnerScore) {
        body = getMessage('rival', 'winning', { score: userScore, rival_score: partnerScore, diff });
      } else if (partnerScore > userScore) {
        body = getMessage('rival', 'losing', { score: userScore, rival_score: partnerScore, diff });
      } else {
        body = getMessage('rival', 'draw', { score: userScore });
      }
    }

  } else if (mode === 'parceiro') {
    if (!userDoneToday && partnerDoneToday) {
      body = getMessage('partner', 'partner_done_you_not');
    } else if (userDoneToday && !partnerDoneToday) {
      body = getMessage('partner', 'you_done_partner_not');
    } else if (!userDoneToday) {
      body = getMessage('partner', 'reminder');
    } else {
      body = getMessage('partner', 'both_done', { n: dayNumber });
    }

  } else if (mode === 'maratona') {
    if (position <= 3) {
      body = getMessage('marathon', 'top3', { pos: position });
    } else if (!userDoneToday) {
      body = getMessage('marathon', 'reminder', { ahead: aheadCount });
    } else {
      body = getMessage('marathon', 'position', { pos: position, ahead: aheadCount });
    }
  }

  return { title, body: body || `Dia ${dayNumber}.` };
}

module.exports = { getMessage, generateNotification };
