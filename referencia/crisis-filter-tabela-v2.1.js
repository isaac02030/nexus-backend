// Cópia congelada de lib/crisis-filter.js do PR 21 (v2.1, casador por tabela
// expandida). Só para o teste de equivalência do casador por partes.
// Não editar: o resultado do lib/ tem de ser igual ao desta cópia.

// ============================================
// NEXUS — Filtro de crise da nota do check-in
//
// Lê a nota de texto livre e devolve:
//   null    → nada encontrado
//   'medio' → desesperança, sentir-se um peso, sem saída
//   'alto'  → vontade de morrer, de se ferir, despedida
//
// É só uma rede de segurança: não é diagnóstico nem avaliação de risco.
// Quando dispara, o servidor não guarda a nota, não a escreve em log
// e não a manda para a IA. A pessoa vê os contatos de ajuda (Tela 9).
//
// A lista segue a lista de palavras do conselho (palavras-filtro.md, v2),
// feita com fontes públicas de prevenção (Ministério da Saúde do Brasil,
// SNS 24, CVV, OMS e outras). Termos de método ficam de fora de propósito.
// PRECISA de revisão de um profissional de saúde mental antes de
// pessoas reais usarem o app.
//
// Todas as frases aqui estão escritas como texto comum. Elas passam pela
// mesma normalização da nota quando o módulo é carregado.
//
// v2: além das frases, o padrão "gatilho + até 2 palavras + alvo" (2.3) e
// as frases sobre outra pessoa (2.4) viram frases comuns ao carregar. As
// exceções por padrão (3.2.1) valem com qualquer gatilho, e a autolesão
// ganha guarda também no ALTO.
//
// v2.1: «desisti da vida/de viver» viram MÉDIO e «morrer/morreu» logo depois
// de um aparelho ou planta ("o celular vai morrer") deixa de disparar.
// ============================================

// 1.1 passo 7: abreviações, só como palavra inteira.
// "num" fica de fora de propósito (também é "em um").
const ABBREVIATIONS = new Map([
  ['n', 'nao'],
  ['naum', 'nao'],
  ['mt', 'muito'],
  ['mto', 'muito'],
  ['to', 'estou'],
  ['tou', 'estou'],
  ['toh', 'estou'],
  ['ta', 'esta'],
  ['tah', 'esta'],
  ['tava', 'estava'],
  ['tb', 'tambem'],
  ['tbm', 'tambem'],
  ['pq', 'porque'],
  ['vc', 'voce'],
  ['ce', 'voce'],
  ['q', 'que'],
  ['td', 'tudo'],
  ['nd', 'nada'],
  ['ngm', 'ninguem'],
  ['agr', 'agora'],
  ['dnv', 'de novo'],
  ['pra', 'para'],
  ['pro', 'para'],
  ['eh', 'e'],
  ['cmg', 'comigo'],
  ['msm', 'mesmo'],
  ['qero', 'quero'],
  ['kero', 'quero'],
  // v2 (2.3.7): abreviações novas de gatilho.
  ['keria', 'queria'],
  ['qria', 'queria'],
  ['qro', 'quero'],
  ['pensano', 'pensando']
]);

// Normaliza na ordem da lista (1.1). Letras repetidas viram uma só,
// na nota e nas frases, para "mataaaar" e "naaao" baterem.
// O resultado é só para comparar (ex.: "morrer" vira "morer"); não é exibido.
function normalizeNote(input) {
  if (input == null) return '';
  let text = String(input).toLowerCase();
  text = text.replace(/ç/g, 'c');
  text = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  text = text.replace(/[-‐-―−]/g, ' ');
  text = text.replace(/[^a-z0-9]+/g, ' ');
  text = text.replace(/([a-z])\1+/g, '$1');
  const words = text.split(' ').filter(Boolean);
  return words
    .map(word => (ABBREVIATIONS.has(word) ? ABBREVIATIONS.get(word) : word))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Nível ALTO (2.1) ----------
const HIGH_PHRASES = [
  // A. Querer morrer / matar-se / não querer viver
  'vou me matar',
  'quero me matar',
  'so quero me matar',
  'eu so quero me matar',
  'quero morrer',
  'quero me suicidar',
  'vou me suicidar',
  'pensar em suicidio',
  'pensando em suicidio',
  'ideacao suicida',
  'nao quero mais viver',
  'nao quero viver',
  'acabar com a minha vida',
  'acabar com minha vida',
  'tirar a minha vida',
  'tirar minha vida',
  'tirar a propria vida',
  'por termo a minha vida',
  'por termo a propria vida',
  'a unica coisa que poderia fazer era me matar',
  'o unico caminho e a morte',
  'preferia estar morto',
  'eu preferia estar morto',
  'preferia estar morta',
  'melhor morto',
  'melhor morta',
  'melhor estar morto',
  'nao vale a pena viver',
  'nao ha mais razao para eu viver',
  'nao tem mais razao para eu viver',
  'estou cansado da vida',
  'estou cansada da vida',
  'cansado de viver',
  'cansada de viver',
  'quero acabar comigo',
  'vou acabar comigo',
  'acabar comigo mesmo',
  'acabar comigo mesma',
  'nao aguento mais viver assim',
  'a minha vida nao tem sentido',
  'to pensando em me matar',
  'to querendo morrer',
  'n quero mais viver',
  'n aguento mais viver',
  'n aguento mais viver assim',
  'queria morrer',
  'so queria morrer',
  'melhor eu morrer',
  'nao aguento mais a vida',
  // B. Dormir e não acordar / desaparecer com sentido de morte
  'dormir e nunca mais acordar',
  'dormir e nao acordar nunca mais',
  'nunca mais acordar',
  'nunca acordar',
  'dormir pra sempre',
  'dormir para sempre',
  'ir dormir para sempre',
  'estariam melhor se eu desaparecesse',
  'ficariam melhores sem mim',
  'voces ficariam melhores sem mim',
  // C. Autolesão (intenção, nunca método)
  'me machucar',
  'machucar a mim',
  'provocar danos a mim',
  'danos a si proprio',
  'me magoar',
  'formas de me magoar',
  'autolesao',
  'comportamento autolesivo',
  'me auto lesionar',
  'automutilacao',
  'quero me cortar',
  'vou me cortar',
  'me cortei de proposito',
  'vontade de me cortar',
  'quero me ferir',
  'vou me ferir',
  'me ferir de proposito',
  // D. Plano, carta ou despedida (sem método)
  'plano de suicidio',
  'plano suicida',
  'pacto de suicidio',
  'carta suicida',
  'bilhete suicida',
  'minha carta suicida',
  'meu bilhete suicida',
  'carta de despedida',
  'escrevi uma despedida',
  'estou me despedindo para sempre',
  // Acréscimos do desenvolvedor, na mesma família das frases acima.
  // Ainda sem revisão profissional (ver o pull request).
  'cansado da vida',
  'cansada da vida',
  'pensando em me matar',
  'penso em me matar',
  'penso em suicidio',
  'pensei em suicidio',
  'vou matar me',
  'quero matar me',
  'me autolesionar',
  'vou desaparecer para sempre',
  'vou desaparecer e nao volto'
];

// ---------- Nível MÉDIO (2.2) ----------
// guard: palavras de treino/estudo logo depois da frase anulam essa ocorrência (3.2).
// upgrade: se a nota também tiver uma destas, a frase vale como ALTO (2.1 B).
// idea: frases da mesma ideia contam uma vez só na regra "2 MÉDIO = ALTO".
// Sem idea, a ideia é a própria linha da tabela da lista (2.2).
const TRAINING = ['serie', 'treino', 'exercicio', 'prova', 'texto', 'capitulo'];
const TIRED_OF = [
  'treino', 'dieta', 'perna', 'cardio', 'burpee', 'estudo', 'prova', 'calor',
  'fila', 'espera', 'chefe', 'trabalho', 'acordar cedo'
];
const PLACES = ['academia', 'ginasio', 'aula', 'escola', 'faculdade', 'trabalho', 'treino'];
const INJURY = ['lesionei', 'lesao', 'lesionado', 'lesionada'];
const EXERCISE = ['treino', 'serie', 'exercicio', 'academia', 'ginasio'];
// 3.2 e 3.2.1: sumir/desaparecer banal, com qualquer gatilho.
const VANISH_BANAL = [
  'fim de semana', 'uns dias', 'por uns dias', 'de ferias', 'da rede',
  'da internet', 'das redes', 'do grupo'
];
const VANISH_DEATH = ['morte', 'morrer', 'paz', 'nao volto', 'para sempre'];

function row(idea, phrases, options = {}) {
  return phrases.map(phrase => ({ phrase, idea, ...options }));
}

const MEDIUM_ENTRIES = [
  // E. Ser um peso / melhor sem mim
  ...row('peso', ['sou um peso', 'sou um peso para os outros', 'sou um peso pra todo mundo',
    'sou um perdedor e um peso para os outros']),
  ...row('fardo', ['me sinto um fardo', 'sinto que sou um fardo', 'sou um fardo para os outros']),
  ...row('mais felizes sem mim', ['os outros vao ser mais felizes sem mim', 'vao ser mais felizes sem mim',
    'serao mais felizes sem mim', 'mais felizes sem mim']),
  ...row('melhor sem mim', ['melhor sem mim']),
  ...row('depois que eu morrer', ['depois que eu morrer']),
  ...row('deixar em paz', ['vou deixar voces em paz', 'vou deixar voce em paz']),
  ...row('nao valho nada', ['nao valho nada', 'nao valer para nada', 'nao valho pra nada']),
  // F. Desesperança, sem saída, vida sem sentido
  ...row('esperanca', ['nao tenho esperanca', 'nao tenho esperanca no futuro', 'sem esperanca',
    'falta de esperanca']),
  ...row('saida', ['nao vejo saida', 'nao vejo nenhuma saida', 'nao vejo luz ao fundo do tunel',
    'nao vejo luz no fim do tunel']),
  ...row('solucao', ['nao vejo solucao', 'nao consigo encontrar uma solucao',
    'nao vejo solucao para os problemas']),
  ...row('encurralado', ['sinto me encurralado', 'sinto me encurralada', 'estou encurralado',
    'estou encurralada']),
  ...row('nada a fazer', ['nao ha mais nada o que fazer', 'nao tem mais o que fazer'], { guard: EXERCISE }),
  ...row('sem sentido', ['minha vida nao tem sentido', 'a vida nao tem sentido', 'nao tenho mais sentido']),
  ...row('estar aqui', ['nao quero estar aqui', 'nao quero mais estar aqui'], { guard: PLACES }),
  ...row('continuar', ['nao consigo continuar'], { guard: TRAINING }),
  ...row('ninguem me entende', ['ninguem me entende']),
  ...row('nao aguento mais', ['nao aguento mais', 'eu nao aguento mais'], { guard: TIRED_OF }),
  ...row('nao posso fazer nada', ['eu nao posso fazer nada'], { guard: INJURY }),
  // B (2.1) e 2.3.3: sumir e desaparecer são a mesma ideia.
  ...row('sumir', ['vou desaparecer'], { guard: VANISH_BANAL, upgrade: VANISH_DEATH }),
  ...row('sumir', ['queria sumir', 'quero sumir para sempre', 'quero sumir', 'queria desaparecer',
    'quero desaparecer'], { guard: VANISH_BANAL }),
  // Informal
  ...row('fundo do poco', ['to no fundo do poco']),
  ...row('limite da vida', ['to no limite da vida']),
  ...row('nao vejo futuro', ['nao vejo futuro']),
  ...row('farto da vida', ['ja nao aguento esta vida', 'to farto da vida', 'estou farto da vida']),
  // 2.3.6: hipotético (MÉDIO).
  ...row('e se eu morresse', ['e se eu morresse']),
  // v2.1 (1): passado em 1.ª pessoa, mesma ideia do alvo "desistir da vida".
  // "desisti" sozinho não dispara; "desisti do treino/da dieta" são exceções.
  ...row('desistir da vida', ['desisti da vida', 'desisti de viver'])
];

// ---------- v2: gatilho + até 2 palavras + alvo (2.3) ----------
// As combinações viram frases comuns quando o módulo carrega; o casador
// (palavras inteiras, mais longa primeiro) é o mesmo da v1.
// first: true = gatilho em 1.ª pessoa (ou forma que também é 1.ª pessoa).
// Só esses abrem o alvo "acabar com a vida" (3.2.1).
function triggers(first, forms) {
  return forms.map(form => ({ form, first }));
}

const TRIGGERS = [
  // Querer
  ...triggers(true, ['quero', 'queria', 'quis', 'quisesse', 'so quero', 'so queria']),
  ...triggers(false, ['quer', 'querer', 'querendo', 'quiser']),
  // Vontade / desejo
  ...triggers(true, ['tenho vontade de', 'da me vontade de']),
  ...triggers(false, ['vontade de', 'desejo de', 'da vontade de', 'deu vontade de', 'dava vontade de']),
  // Pensar em
  ...triggers(true, ['penso em', 'pensei em', 'pensava em', 'tenho pensado em', 'ando pensando em']),
  ...triggers(false, ['pensar em', 'pensando em', 'pensa em', 'pensou em']),
  // Pensar em (pt-PT)
  ...triggers(true, ['estou a pensar em', 'estava a pensar em', 'ando a pensar em']),
  // Ideia / pensamento de
  ...triggers(false, ['ideia de', 'ideias de', 'pensamento de', 'pensamentos de']),
  // Intenção / decisão
  ...triggers(true, ['vou', 'ia', 'decidi', 'resolvi', 'preciso', 'tenho que', 'tenho de']),
  // Tentativa
  ...triggers(true, ['tentei', 'ja tentei']),
  ...triggers(false, ['tentar', 'tentando', 'tentativa de']),
  // Coragem
  ...triggers(false, ['coragem de', 'coragem para', 'ter coragem de']),
  // Apetecer (pt-PT)
  ...triggers(true, ['apetece me', 'apetecia me']),
  // Preferência
  ...triggers(true, ['prefiro', 'preferia', 'melhor se eu', 'ia ser melhor eu']),
  ...triggers(false, ['melhor', 'seria melhor']),
  // Gerúndio e "vontade de" não têm pessoa; com "estou/estava" na frente, são 1.ª pessoa
  // (mesmas formas da lista, só marcadas para o alvo "acabar com a vida").
  ...triggers(true, ['estou pensando em', 'estava pensando em', 'estou querendo', 'estava querendo',
    'estou com vontade de', 'estava com vontade de']),
  // Causar o desejo ("fez querer" já cai em "querer"; com "me" é 1.ª pessoa)
  ...triggers(true, ['me fez querer', 'me faz querer', 'me fazia querer', 'me fez ter vontade de']),
  ...triggers(false, ['fez querer', 'faz querer', 'fazia querer', 'fez ter vontade de'])
];

// 0 a 2 palavras, só desta lista. Qualquer outra palavra no meio quebra o padrão.
const FILLER = ['muito', 'mesmo', 'so', 'ate', 'ja', 'agora', 'de verdade', 'poder', 'ter', 'mais', 'eu', 'de vez'];

// Alvos ALTO (2.3.2). typos: «r» caído e letra trocada (2.3.7); como todo alvo
// só existe depois de um gatilho, essas formas nunca disparam soltas.
// guardAfter vale para toda frase com estes alvos. guardBefore ("medo de"...)
// só vale colado ao alvo nu: com gatilho no meio ("tenho medo de querer me
// machucar") a frase dispara.
const SELF_HARM_GUARD = {
  guardAfter: ['treino', 'serie', 'exercicio', 'academia', 'ginasio']
};
const SELF_HARM_GUARD_BARE = {
  ...SELF_HARM_GUARD,
  guardBefore: ['medo de', 'para nao', 'evitar', 'cuidado para nao', 'risco de']
};
// Alvos nus da v1 (sem gatilho na frente), os únicos com guarda antes.
const HIGH_BARE_V1 = new Set(['me machucar', 'me magoar']);

const KILL_SELF = ['me matar', 'matar me', 'mematar', 'matarme'];
const KILL_SELF_TYPOS = ['me mata', 'me matr', 'me matra', 'me mtar'];
const SUICIDE_SELF = ['me suicidar', 'suicidar me', 'mesuicidar', 'suicidarme'];
const SUICIDE_SELF_TYPOS = ['me suicida', 'me sucidar', 'me suicdar'];
const DIE = ['morrer'];
const DIE_TYPOS = ['morre'];

const HIGH_TARGETS = [
  ...KILL_SELF.map(t => ({ target: t })),
  ...KILL_SELF_TYPOS.map(t => ({ target: t })),
  ...SUICIDE_SELF.map(t => ({ target: t })),
  ...SUICIDE_SELF_TYPOS.map(t => ({ target: t })),
  ...DIE.map(t => ({ target: t })),
  ...DIE_TYPOS.map(t => ({ target: t })),
  { target: 'tirar me a vida' }, { target: 'tirar a minha vida' }, { target: 'tirar a propria vida' },
  { target: 'por fim a minha vida' }, { target: 'por fim a propria vida' },
  { target: 'dar fim a minha vida' }, { target: 'dar fim a propria vida' },
  { target: 'acabar com a vida', firstPersonOnly: true },
  { target: 'estar morto' }, { target: 'estar morta' },
  { target: 'pensamentos de morte' }, { target: 'pensamentos suicidas' },
  { target: 'ideias suicidas' }, { target: 'pensamento suicida' },
  { target: 'me machucar', ...SELF_HARM_GUARD },
  { target: 'me magoar', ...SELF_HARM_GUARD },
  { target: 'me ferir', ...SELF_HARM_GUARD },
  { target: 'me cortar', ...SELF_HARM_GUARD }
];

// Alvos MÉDIO (2.3.3). Duas ideias diferentes na mesma nota = ALTO.
const MEDIUM_TARGETS = [
  { target: 'sumir', idea: 'sumir', guard: VANISH_BANAL },
  { target: 'desaparecer', idea: 'sumir', guard: VANISH_BANAL },
  { target: 'nao existir', idea: 'nao existir' },
  { target: 'nao ter nascido', idea: 'nao ter nascido' },
  { target: 'nao acordar', idea: 'nao acordar' },
  { target: 'acabar com tudo', idea: 'acabar com tudo' },
  { target: 'desistir da vida', idea: 'desistir da vida' },
  { target: 'desistir de viver', idea: 'desistir da vida' }
];

// 2.4: frases sobre outra pessoa também são ALTO, sem exceção de filme ou livro.
const OTHER_TRIGGERS = ['quer', 'vai', 'ia', 'disse que vai', 'ameacou', 'fala em', 'pensa em',
  'tentou', 'quis', 'ja tentou'];
const OTHER_TARGETS = ['se matar', 'matar se', 'se suicidar', 'suicidar se', 'tirar a propria vida', 'morrer'];

// Sequências de enchimento com 0, 1 ou 2 palavras no total.
function fillerSequences() {
  const out = [''];
  const wordCount = text => text.split(' ').length;
  for (const a of FILLER) {
    if (wordCount(a) <= 2) out.push(a);
    for (const b of FILLER) {
      if (wordCount(a) + wordCount(b) <= 2) out.push(`${a} ${b}`);
    }
  }
  return out;
}

function combine(triggerForms, fillers, target) {
  const out = [];
  for (const trigger of triggerForms) {
    for (const filler of fillers) {
      out.push(filler ? `${trigger} ${filler} ${target}` : `${trigger} ${target}`);
    }
  }
  return out;
}

// Cada parte é normalizada antes de juntar (dá o mesmo que normalizar a frase
// inteira, porque a normalização trabalha palavra a palavra) e só uma vez.
function expandPattern() {
  const n = list => list.map(normalizeNote);
  const fillers = n(fillerSequences());
  const allForms = n(TRIGGERS.map(t => t.form));
  const firstForms = n(TRIGGERS.filter(t => t.first).map(t => t.form));
  const otherForms = n(OTHER_TRIGGERS);
  const high = [];
  for (const raw of HIGH_TARGETS) {
    const { target, firstPersonOnly, guardBefore, guardAfter } = normalizeOptions(raw);
    const forms = firstPersonOnly ? firstForms : allForms;
    for (const phrase of combine(forms, fillers, normalizeNote(target))) {
      high.push({ phrase, guardBefore, guardAfter });
    }
  }
  for (const target of n(OTHER_TARGETS)) {
    for (const phrase of combine(otherForms, fillers, target)) high.push({ phrase });
  }
  const medium = [];
  for (const raw of MEDIUM_TARGETS) {
    const { target, idea, guard } = normalizeOptions(raw);
    for (const phrase of combine(allForms, fillers, normalizeNote(target))) {
      medium.push({ phrase, idea, guard });
    }
  }
  return { high, medium };
}

// Frases ALTO da v2 que não seguem o padrão (2.3.2, 2.3.5, 2.3.6, 2.3.7).
const HIGH_PHRASES_V2 = [
  // 2.3.2: já trazem o próprio sinal.
  'pensamentos de morte', 'pensamentos suicidas', 'ideias suicidas', 'pensamento suicida',
  // 2.3.5: família «não querer viver»
  'nao queria viver', 'nao queria mais viver', 'nao quis viver', 'nao quer mais viver',
  'nao aguentava mais viver', 'nao aguento viver', 'nao suporto mais viver', 'nao consigo mais viver',
  'cansei de viver', 'ja cansei de viver', 'farto de viver',
  'nao quero estar vivo', 'nao quero estar viva', 'nao quero mais estar vivo', 'nao quero mais estar viva',
  'nao queria estar vivo', 'nao queria estar viva', 'nao queria mais existir',
  // 2.3.6: hipotético
  'melhor se eu morresse', 'seria melhor se eu morresse', 'se eu me matasse', 'quem me dera morrer',
  'ia ser melhor eu morrer', 'prefiro morrer', 'preferia morrer',
  // 2.3.7: erro de letra no alvo, sempre depois de gatilho
  'pensar em sucidio', 'pensar em suicido', 'pensando em sucidio', 'pensando em suicido',
  'penso em sucidio', 'penso em suicido', 'pensei em sucidio', 'pensei em suicido'
];

// Autolesão da v1 que também ganha a guarda (1.2, 3.2.1).
const HIGH_GUARDED_V1 = new Set([
  'me machucar', 'me magoar', 'quero me cortar', 'vou me cortar', 'vontade de me cortar',
  'quero me ferir', 'vou me ferir', 'formas de me magoar'
]);

// ---------- Exceções (3.2 e 3.2.1), aplicadas antes de tudo ----------
const EXCEPTIONS_V1 = [
  'matar aula', 'matar a aula', 'matar o treino', 'matar a fome', 'matar a saudade',
  'matar o tempo', 'matar o jogo', 'matar no peito',
  'me mato de estudar', 'me mato de treinar', 'me mato de trabalhar', 'me mato de rir',
  'vou me matar de treinar', 'vou me matar de estudar', 'vou me matar de trabalhar',
  'vou me matar de rir', 'me mata de rir', 'morrer de rir', 'morri de rir',
  'morri de vergonha', 'morrer de sono', 'morrer de fome', 'morrer de vontade',
  'morrer de saudade',
  'o treino me matou', 'o cardio me matou', 'a prova me matou',
  'estou morto', 'estou morta', 'to morto', 'to morta', 'andei morto', 'fiquei morto',
  'pior treino da vida', 'pior dia de treino', 'morri no treino',
  'desistir do treino', 'desisti do treino', 'desistir da dieta', 'desistir da missao',
  'desistir do acucar', 'desisti no meio da serie',
  'cortar acucar', 'cortar o acucar', 'cortar cabelo', 'cortar o cabelo',
  'cortar calorias', 'cortar carboidrato', 'cortar gastos', 'cortar caminho',
  'cortar o cafe',
  'quebrar recorde', 'quebra de recorde'
];

// 3.2.1: exceções por padrão, que valem com qualquer gatilho.
function exceptionPairs(heads, tails) {
  const out = [];
  for (const head of heads) for (const tail of tails) out.push(`${head} ${tail}`);
  return out;
}

const EXCEPTIONS_V2 = [
  ...exceptionPairs(
    [...KILL_SELF, ...KILL_SELF_TYPOS, 'se matar', 'matar se'].map(t => `${t} de`),
    ['rir', 'tanto rir', 'treinar', 'estudar', 'trabalhar', 'correr', 'tanto treinar', 'tanto estudar',
      'tanto trabalhar']
  ),
  ...exceptionPairs(
    [...DIE, ...DIE_TYPOS].map(t => `${t} de`),
    ['rir', 'tanto rir', 'vergonha', 'sono', 'fome', 'calor', 'frio', 'saudade', 'vontade', 'cansaco',
      'tedio', 'ciume', 'inveja']
  ),
  ...exceptionPairs(['morto de', 'morta de'], ['cansaco', 'sono', 'fome', 'rir', 'vergonha', 'calor']),
  ...exceptionPairs(['se matar', 'matar se'], ['na final', 'no jogo', 'na quadra']),
  ...exceptionPairs(['morri', 'me matou', ...KILL_SELF], ['no jogo', 'na partida', 'na fase']),
  ...exceptionPairs(
    [...DIE, ...DIE_TYPOS].flatMap(t => [`${t} a`, `${t} do que`]),
    ['treino', 'dieta', 'acordar', 'correr', 'estudar', 'limpar']
  ),
  ...exceptionPairs(
    ['me cortar do', 'me cortar da', 'me cortar dos', 'me cortar das'],
    ['acucar', 'doce', 'doces', 'carboidrato', 'redes', 'cafe', 'alcool', 'fritura']
  ),
  // Meta de longevidade. "morrer em paz" e "morrer dormindo" ficam de fora de propósito.
  ...exceptionPairs([...DIE, ...DIE_TYPOS],
    ['velho', 'velha', 'velhinho', 'velhinha', 'de velhice', 'saudavel', 'em forma'])
];

// v2.1 (4): «morrer/morreu» até 2 palavras depois de um aparelho ou planta
// ("o celular vai morrer", "a bateria do celular vai morrer hoje").
// Não é frase fixa porque as palavras do meio são quaisquer; nunca atravessa
// pontuação. Se as palavras do meio terminam num gatilho em 1.ª pessoa
// ("larguei o celular e quero morrer"), a exceção não vale: na dúvida, a tela aparece.
const DEVICES = new Set(['celular', 'telefone', 'bateria', 'computador', 'notebook', 'planta', 'plantas']
  .map(normalizeNote));
const DEVICE_DIE = new Set(['morrer', 'morreu'].map(normalizeNote));
const DEVICE_GAP_WORDS = 2;

// Quantas palavras depois da frase contam como "colado" para a exceção.
// Janela curta de propósito: na dúvida, a tela aparece (3.3).
const GUARD_WINDOW_WORDS = 5;
// Guarda no ALTO (autolesão): janela ainda mais curta, e para no corte de
// uma exceção. Errar aqui esconde um ALTO, então só vale o que está colado.
const HIGH_GUARD_WINDOW_WORDS = 3;

// Guarda cada frase uma vez (a primeira que aparece vale) e lembra a ordem.
// A ordem "mais longa primeiro" (1.2) é aplicada na hora de casar, só nas
// frases que aparecem na nota: o resultado é o mesmo de ordenar tudo antes.
function normalizeEntry(entry, normalized) {
  const raw = typeof entry === 'string' ? { phrase: entry } : entry;
  const norm = normalized ? (text => text) : normalizeNote;
  const phrase = norm(raw.phrase);
  return {
    phrase,
    words: phrase.split(' ').length,
    idea: raw.idea ? normalizeNote(raw.idea) : phrase,
    guard: raw.guard || [],
    upgrade: raw.upgrade || [],
    guardBefore: raw.guardBefore || [],
    guardAfter: raw.guardAfter || []
  };
}

function normalizeOptions(raw) {
  const out = { ...raw };
  for (const key of ['guard', 'upgrade', 'guardBefore', 'guardAfter']) {
    if (raw[key]) out[key] = raw[key].map(normalizeNote);
  }
  return out;
}

function buildTable(plainEntries, normalizedEntries = []) {
  const table = new Map();
  let maxWords = 1;
  const add = (entry) => {
    if (!entry.phrase || table.has(entry.phrase)) return;
    entry.order = table.size;
    table.set(entry.phrase, entry);
    if (entry.words > maxWords) maxWords = entry.words;
  };
  for (const entry of plainEntries) {
    add(normalizeEntry(typeof entry === 'string' ? entry : normalizeOptions(entry), false));
  }
  for (const entry of normalizedEntries) add(normalizeEntry(entry, true));
  return { table, maxWords };
}

// A nota vira uma lista de palavras com dois marcadores:
//   HARD ("|"): corte deixado por uma exceção ou por uma frase já usada.
//               Nada atravessa.
//   SOFT ("¦"): pontuação (. ! ? ; … , : e quebra de linha). Exceções e guardas
//               nunca atravessam. Frases de risco não atravessam na 1.ª leitura
//               e atravessam na 2.ª ("quero. me matar" dispara).
const HARD = '|';
const SOFT = '\u00a6';
const isMark = token => token === HARD || token === SOFT;

// Onde a frase começa em tokens[start], devolve o fim (exclusivo), ou -1.
// crossSoft: pula pontuação entre as palavras da frase (nunca um HARD).
function matchAt(tokens, words, start, crossSoft) {
  if (tokens[start] !== words[0]) return -1;
  let k = start + 1;
  for (let w = 1; w < words.length; w++) {
    if (crossSoft) while (tokens[k] === SOFT) k++;
    if (tokens[k] !== words[w]) return -1;
    k++;
  }
  return k;
}

function findFrom(tokens, words, from, crossSoft) {
  for (let i = from; i < tokens.length; i++) {
    const end = matchAt(tokens, words, i, crossSoft);
    if (end >= 0) return { start: i, end };
  }
  return null;
}

// Frases da tabela que aparecem na nota (como palavras inteiras), mais longa primeiro.
function candidates({ table, maxWords }, tokens, crossSoft) {
  const found = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (isMark(tokens[i])) continue;
    let gram = '';
    let n = 0;
    for (let k = i; k < tokens.length && n < maxWords; k++) {
      if (tokens[k] === HARD) break;
      if (tokens[k] === SOFT) {
        if (crossSoft) continue;
        break;
      }
      gram = n === 0 ? tokens[k] : `${gram} ${tokens[k]}`;
      n++;
      const entry = table.get(gram);
      if (entry) found.add(entry);
    }
  }
  return [...found].sort((a, b) => (b.phrase.length - a.phrase.length) || (a.order - b.order));
}

const EXPANDED = expandPattern();

// A v1 vem primeiro: numa frase repetida, valem as regras dela.
const HIGH = buildTable([
  ...HIGH_PHRASES.map((phrase) => {
    if (HIGH_BARE_V1.has(phrase)) return { phrase, ...SELF_HARM_GUARD_BARE };
    if (HIGH_GUARDED_V1.has(phrase)) return { phrase, ...SELF_HARM_GUARD };
    return phrase;
  }),
  ...HIGH_PHRASES_V2
], EXPANDED.high);
const MEDIUM = buildTable(MEDIUM_ENTRIES, EXPANDED.medium);
const EXCEPT = buildTable([...EXCEPTIONS_V1, ...EXCEPTIONS_V2]);

function cutOut(tokens, { start, end }) {
  return [...tokens.slice(0, start), HARD, ...tokens.slice(end)];
}

function hasWords(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

function endsWithWords(haystack, needle) {
  return ` ${haystack}`.endsWith(` ${needle}`);
}

// Palavras coladas antes e depois de uma ocorrência, parando em qualquer marcador.
function nearWords(tokens, start, end, count) {
  const before = [];
  for (let k = start - 1; k >= 0 && before.length < count && !isMark(tokens[k]); k--) before.unshift(tokens[k]);
  const after = [];
  for (let k = end; k < tokens.length && after.length < count && !isMark(tokens[k]); k++) after.push(tokens[k]);
  return { before: before.join(' '), after: after.join(' ') };
}

// Fins de gatilho em 1.ª pessoa (gatilho + enchimento), para a exceção dos aparelhos.
function firstPersonLeads() {
  const out = new Set();
  const fillers = fillerSequences().map(normalizeNote);
  for (const { form, first } of TRIGGERS) {
    if (!first) continue;
    const trigger = normalizeNote(form);
    for (const filler of fillers) out.add(filler ? `${trigger} ${filler}` : trigger);
  }
  return out;
}
const FIRST_PERSON_LEADS = firstPersonLeads();

function endsWithFirstPersonLead(words) {
  for (let s = 0; s < words.length; s++) {
    if (FIRST_PERSON_LEADS.has(words.slice(s).join(' '))) return true;
  }
  return false;
}

// Corta "aparelho + até 2 palavras + morrer/morreu", pegando o aparelho mais perto.
function removeDeviceDeaths(tokens) {
  let out = tokens;
  for (let j = 0; j < out.length; j++) {
    if (!DEVICE_DIE.has(out[j])) continue;
    for (let gap = 0; gap <= DEVICE_GAP_WORDS; gap++) {
      const i = j - gap - 1;
      if (i < 0 || isMark(out[i])) break;
      if (!DEVICES.has(out[i])) continue;
      if (!endsWithFirstPersonLead(out.slice(i + 1, j))) {
        out = cutOut(out, { start: i, end: j + 1 });
        j = i;
      }
      break;
    }
  }
  return out;
}

// Tira todas as ocorrências das exceções, deixando um corte no lugar,
// para nenhuma frase de risco atravessar a exceção. Exceção nunca atravessa
// pontuação ("quero morrer, velho amigo" não é exceção).
function removeExceptions(tokens) {
  let out = tokens;
  for (const { phrase } of candidates(EXCEPT, tokens, false)) {
    const words = phrase.split(' ');
    let hit = findFrom(out, words, 0, false);
    while (hit) {
      out = cutOut(out, hit);
      hit = findFrom(out, words, hit.start + 1, false);
    }
  }
  return removeDeviceDeaths(out);
}

function isGuardedHigh(entry, tokens, hit) {
  if (!entry.guardBefore.length && !entry.guardAfter.length) return false;
  const near = nearWords(tokens, hit.start, hit.end, HIGH_GUARD_WINDOW_WORDS);
  return entry.guardBefore.some(word => endsWithWords(near.before, word))
    || entry.guardAfter.some(word => hasWords(near.after, word));
}

function classifyTokens(original, crossSoft) {
  let tokens = original;

  for (const entry of candidates(HIGH, tokens, crossSoft)) {
    const words = entry.phrase.split(' ');
    let hit = findFrom(tokens, words, 0, crossSoft);
    while (hit) {
      if (!isGuardedHigh(entry, tokens, hit)) return 'alto';
      // Ocorrência com guarda: sai da nota, para uma frase mais curta não a pegar.
      tokens = cutOut(tokens, hit);
      hit = findFrom(tokens, words, hit.start + 1, crossSoft);
    }
  }

  // Ideias diferentes, não ocorrências: a mesma ideia repetida conta uma vez.
  const noteWords = original.filter(token => !isMark(token)).join(' ');
  const mediumIdeas = new Set();
  for (const { phrase, idea, guard, upgrade } of candidates(MEDIUM, tokens, crossSoft)) {
    const words = phrase.split(' ');
    let hit = findFrom(tokens, words, 0, crossSoft);
    while (hit) {
      const after = nearWords(tokens, hit.start, hit.end, GUARD_WINDOW_WORDS).after;
      const guarded = guard.some(word => hasWords(after, word));
      if (!guarded) {
        if (upgrade.some(word => hasWords(noteWords, word))) return 'alto';
        mediumIdeas.add(idea);
      }
      // Some a frase usada, para uma frase mais curta dentro dela não contar de novo.
      tokens = cutOut(tokens, hit);
      hit = findFrom(tokens, words, hit.start + 1, crossSoft);
    }
  }

  // Duas ou mais ideias MÉDIO na mesma nota valem como ALTO (1.2).
  if (mediumIdeas.size >= 2) return 'alto';
  if (mediumIdeas.size === 1) return 'medio';
  return null;
}

const PUNCTUATION_BREAK = /[.!?;…,:\r\n\u2028\u2029]+/;

// Normaliza pedaço a pedaço e põe a pontuação como marcador SOFT.
function tokenize(input) {
  const tokens = [];
  for (const part of String(input).split(PUNCTUATION_BREAK)) {
    const words = normalizeNote(part).split(' ').filter(Boolean);
    if (!words.length) continue;
    if (tokens.length) tokens.push(SOFT);
    tokens.push(...words);
  }
  return tokens;
}

const RANK = { alto: 2, medio: 1 };

function classifyNote(note) {
  if (note == null) return null;
  const tokens = tokenize(note);
  if (!tokens.length) return null;
  // Exceções saem antes, sem atravessar pontuação, e valem nas duas leituras.
  const cleaned = removeExceptions(tokens);
  // 1.ª leitura: a pontuação corta tudo. 2.ª leitura: a pontuação não corta
  // as frases de risco (guardas continuam cortadas). Vale o nível mais alto.
  const strict = classifyTokens(cleaned, false);
  if (strict === 'alto') return 'alto';
  const loose = classifyTokens(cleaned, true);
  return (RANK[loose] || 0) > (RANK[strict] || 0) ? loose : strict;
}

module.exports = {
  classifyNote,
  normalizeNote,
  GUARD_WINDOW_WORDS,
  HIGH_GUARD_WINDOW_WORDS
};
