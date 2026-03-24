// ============================================
// NEXUS - GRANDE IRMAO
// Sistema de mensagens contextuais
// Calmo. Observador. Preciso.
// ============================================

const MESSAGES = {
  solo: {
    day_1: [
      "Dia 1. Comeca.",
      "O primeiro dia define o padrao.",
      "Dia 1. O resto vem depois.",
      "Dia 1. O registo comeca agora."
    ],
    day_n: [
      "Dia {n}. Mantens.",
      "Dia {n}.",
      "Dia {n}. Continua.",
      "Dia {n}. A sequencia esta intacta.",
      "Dia {n}. O registo confirma."
    ],
    good_streak: [
      "{n} dias seguidos. Continua.",
      "{n} dias. Nao pares agora.",
      "Sequencia de {n}. Raros chegam aqui.",
      "{n} dias. O padrao ja existe."
    ],
    failed: [
      "Hoje falhaste. Amanha e o que importa.",
      "A sequencia quebrou. Recomeca amanha.",
      "Um dia perdido. So um.",
      "Hoje falhaste.",
      "O registo nao mente sobre hoje."
    ],
    recovery: [
      "Ontem caiu. Hoje recuperas.",
      "Hoje e retorno. Sem teatro.",
      "O dia anterior falhou. Este ainda nao.",
      "Nao reescrevas o registo. Corrige-o."
    ],
    waiting: [
      "Ainda sem parceiro. A missao nao espera.",
      "Estas sozinho. Por enquanto.",
      "Sem match ainda. Continua.",
      "A espera nao e pausa. E tempo.",
      "Mesmo sem par, o olhar permanece."
    ],
    reminder: [
      "O check-in de hoje ainda nao foi feito.",
      "Dia {n}. Estas a atrasar.",
      "Ainda a tempo. Por pouco.",
      "Estas a atrasar.",
      "O Grande Irmao ainda nao viu prova.",
      "Nao confundas intencao com registo."
    ]
  },

  rival: {
    rival_done_you_not: [
      "Ele ja fez check-in.",
      "O teu rival fez check-in. Tu nao.",
      "Ele nao esperou. Tu ainda estas a tempo.",
      "Ja foi. Tu ainda nao.",
      "O placar ja tem factos. Falta o teu."
    ],
    you_done_rival_not: [
      "Fizeste o check-in. Ele ainda nao.",
      "Estas a frente. Por hoje.",
      "Ganhaste o dia. Amanha recomeca.",
      "O dia foi teu."
    ],
    both_done: [
      "Ambos fizeram check-in. Empate no dia.",
      "Dia {n} para os dois.",
      "Nenhum cedeu hoje."
    ],
    none_done: [
      "Nenhum dos dois fez check-in.",
      "O dia ainda nao comecou para nenhum.",
      "Quem vai primeiro?"
    ],
    winning: [
      "{score} a {rival_score}. Mantem.",
      "Estas a frente. Nao relaxes.",
      "{diff} dias de vantagem. Continua.",
      "Estas a frente. Nao deixes o registo inverter."
    ],
    losing: [
      "{rival_score} a {score}. A diferenca e {diff} dia.",
      "Estas atras. Ainda da para recuperar.",
      "Ele ganhou {diff} dias. Tu podes ganhar de volta.",
      "O registo favorece-o. Ainda."
    ],
    draw: [
      "{score} a {score}. Empate.",
      "Estao iguais. O proximo check-in decide.",
      "A diferenca e zero. Por agora."
    ],
    reminder: [
      "Vai deixar o teu rival ganhar hoje?",
      "Ele ja fez. Tu nao.",
      "O rival nao parou. Tu?",
      "Hoje o teu nome ainda nao entrou no quadro."
    ]
  },

  partner: {
    partner_done_you_not: [
      "O teu parceiro fez check-in. Falta o teu.",
      "Ele nao faltou. Tu?",
      "O teu parceiro esta a espera do teu check-in.",
      "Nao deixes o teu parceiro sozinho.",
      "A dupla ainda nao esta completa."
    ],
    you_done_partner_not: [
      "Fizeste o teu. Falta o teu parceiro.",
      "Estas feito. O teu parceiro ainda nao.",
      "A tua parte esta feita."
    ],
    both_done: [
      "Dia {n} completo para os dois.",
      "Ambos fizeram. Assim se constroi.",
      "Nenhum falhou hoje."
    ],
    none_done: [
      "Nenhum dos dois fez check-in ainda.",
      "O dia esta a passar."
    ],
    reminder: [
      "Nao deixes o teu parceiro na mao.",
      "O teu parceiro conta contigo.",
      "Ele esta a espera do teu check-in.",
      "Hoje, metade da dupla ainda falta."
    ]
  },

  marathon: {
    position: [
      "Estas em {pos}o lugar.",
      "Posicao {pos}. Ha {ahead} a tua frente.",
      "{pos}o. A maratona nao para."
    ],
    top3: [
      "Estas no top 3. Mantem.",
      "{pos}o lugar. Poucos chegam aqui.",
      "Top 3. Nao cedas agora."
    ],
    reminder: [
      "{ahead} pessoas a tua frente fizeram check-in hoje.",
      "A maratona nao para. Tu?",
      "O ranking esta a mudar. Faz o teu check-in.",
      "O quadro mexe-se sem esperar por ti."
    ],
    completed: [
      "Maratona concluida. {pos}o lugar final.",
      "Terminaste em {pos}o. A proxima comeca quando quiseres."
    ]
  },

  milestones: {
    day_7: ["7 dias. Uma semana inteira.", "Semana 1 completa."],
    day_14: ["Metade do caminho.", "Dia 14. A meio."],
    day_21: ["21 dias. O habito comeca a formar-se.", "3 semanas. Continua."],
    day_30: ["30 dias. Missao completa.", "Chegaste ao fim. Poucos chegam.", "30 dias. O registo fecha sem favor."]
  }
};

function getMessage(category, key, vars = {}) {
  const pool = MESSAGES[category]?.[key];
  if (!pool || pool.length === 0) return null;

  let msg = pool[Math.floor(Math.random() * pool.length)];
  Object.entries(vars).forEach(([k, v]) => {
    msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  });

  return msg;
}

function getMissionSpecificBody(context) {
  const {
    category,
    userDoneToday,
    recoveryNeeded,
    dailyMinimum,
    commitmentWindow,
    whyItMatters,
    studyFocus,
    studyCurrentStage,
    studyTargetOutcome,
    latestProof
  } = context;

  if (category === 'aprendizagem') {
    const minimum = dailyMinimum || '1 bloco focado';
    const focus = studyFocus || 'o estudo de hoje';
    const stage = studyCurrentStage || 'o bloco atual';
    const target = studyTargetOutcome || 'o fecho destes 30 dias';

    if (userDoneToday) {
      return `Registo fechado em ${focus}, bloco ${stage}. O proximo passo aproxima ${target}.`;
    }

    if (recoveryNeeded) {
      return `Nao avances sem base. Fecha ${minimum} em ${stage} e volta a por ordem em ${focus}.`;
    }

    return `Ainda falta ${minimum} em ${stage}. Sem clareza, ${focus} espalha-se.`;
  }

  if (category === 'fitness') {
    if (userDoneToday && latestProof) {
      return `Prova registada. ${latestProof}`;
    }

    if (!userDoneToday) {
      return 'Sem prova, fica intencao.';
    }
  }

  if (category === 'criatividade') {
    const minimum = dailyMinimum || '1 saida pequena';
    const windowText = commitmentWindow || 'a janela prometida';

    if (userDoneToday && latestProof) {
      return `Saida registada. ${latestProof}`;
    }

    if (recoveryNeeded) {
      return `Nao procures brilho. Procura entrega. Fecha ${minimum} em ${windowText} e poe algo no registo.`;
    }

    return `Hoje ainda falta uma saida. Fecha ${minimum} em ${windowText}. Sem artefacto, fica so intencao.`;
  }

  if (category === 'habito') {
    const minimum = dailyMinimum || 'a versao minima do habito';
    const windowText = commitmentWindow || 'a janela prometida';
    const motive = whyItMatters || 'o motivo que deste a esta promessa';

    if (userDoneToday) {
      return `Registo feito. O habito nao pede entusiasmo. Pede repeticao. Amanhã voltas em ${windowText}.`;
    }

    if (recoveryNeeded) {
      return `Ontem falhou. Hoje fecha ${minimum} em ${windowText}. O motivo continua: ${motive}.`;
    }

    return `Ainda falta ${minimum}. O habito forma-se quando deixas de discutir com ${motive}.`;
  }

  return null;
}

function generateNotification(context) {
  const {
    mode,
    category,
    dayNumber,
    streak,
    userScore,
    partnerScore,
    rivalDoneToday,
    partnerDoneToday,
    userDoneToday,
    position,
    aheadCount,
    isWaiting,
    recoveryNeeded
  } = context;

  const title = 'GRANDE IRMAO';
  let body = '';
  const missionSpecificBody = getMissionSpecificBody(context);

  if ([7, 14, 21, 30].includes(dayNumber) && userDoneToday) {
    const key = `day_${dayNumber}`;
    body = getMessage('milestones', key) || `Dia ${dayNumber}.`;
    return { title, body: missionSpecificBody || body };
  }

  if (missionSpecificBody && ['aprendizagem', 'fitness', 'criatividade', 'habito'].includes(category)) {
    return { title, body: missionSpecificBody };
  }

  if (mode === 'solo' || isWaiting) {
    if (isWaiting) {
      body = getMessage('solo', 'waiting');
    } else if (recoveryNeeded) {
      body = getMessage('solo', 'recovery');
    } else if (!userDoneToday) {
      body = getMessage('solo', 'reminder', { n: dayNumber });
    } else if (streak >= 3) {
      body = getMessage('solo', 'good_streak', { n: streak });
    } else if (dayNumber === 1) {
      body = getMessage('solo', 'day_1');
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
