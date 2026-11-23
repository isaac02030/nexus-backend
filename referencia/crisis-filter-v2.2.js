// Cópia congelada de lib/crisis-filter.js da v2.2 (codex, antes da v2.3).
// Só para o teste que prova que a v2.3 nunca desce de nível fora das
// exceções aprovadas. Não editar.

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
// as frases sobre outra pessoa (2.4). As exceções por padrão (3.2.1) valem
// com qualquer gatilho, e a autolesão ganha guarda também no ALTO.
// O padrão é comparado por partes (gatilho, enchimento, alvo): as cerca de
// 300 mil combinações não ficam guardadas. O resultado é o mesmo da tabela
// expandida (teste de equivalência contra referencia/crisis-filter-tabela-v2.1.js).
//
// v2.1: «desisti da vida/de viver» viram MÉDIO e «morrer/morreu» logo depois
// de um aparelho ou planta ("o celular vai morrer") deixa de disparar.
//
// v2.2 (proposta de 22/11, aprovada pelo dono do projeto):
//   - «mato-me», «me matei», «matou-se», «suicidar-me»... disparam sem gatilho;
//     o infinitivo nu («matar-me», «me matar», «matar-se») só quando o trecho
//     é só isso (mais até 2 palavras de enchimento);
//   - exceções «a/de + verbo» («mato-me a trabalhar») e guarda do «mato» (floresta);
//   - gatilhos novos para «me matar»: hei de, devia, devo, mais vale, melhor era,
//     talvez devesse; alvo novo «ter morrido»;
//   - palavra de morte + até 4 palavras + «e eu junto» e afins.
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
// Cada combinação conta como uma frase comum (palavras inteiras, mais longa
// primeiro), mas é reconhecida por partes na hora de casar.
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

// Desvios conscientes da proposta v2.2 (a pesquisadora concordou com os 4;
// ver a descrição do PR 23):
//   1. «morra»/«morro» só contam com dois erres na nota escrita (a normalização
//      os iguala a «mora»/«moro», do verbo morar). Ver juntoMatches.
//   2. «hoje» entra como enchimento só no infinitivo nu (exemplo da proposta).
//   3. «suicidar» não ganha as exceções «a/de + verbo»: calaria
//      «vou me suicidar de tanto trabalhar».
//   4. «ter morrido de ...» só com rir, vergonha e sono.
// v2.2 (1.1): sobem a ALTO sem gatilho. «mato me» e «me mato» não valem logo
// depois de no/do/pelo/ao/um/o (o «mato» da floresta: «no mato me escondi»).
const MATO_NOUN_BEFORE = ['no', 'do', 'pelo', 'ao', 'um', 'o'];
const KILL_SELF_BARE = [
  'mato me', 'me mato', 'matei me', 'me matei', 'matar me ei', 'matarei me',
  'matou se', 'se matou', 'mataram se', 'se mataram', 'mematar', 'matarme'
];
// Só as formas que não eram alvo na v2.1 (sem os colados de KILL_SELF).
const KILL_SELF_BARE_NEW = KILL_SELF_BARE.filter(t => !KILL_SELF.includes(t));
const SUICIDE_SELF_BARE = ['mesuicidar', 'suicidarme', 'suicidar me', 'me suicidar', 'me suicidei', 'suicidei me'];
const HIGH_PHRASES_V22 = [
  ...KILL_SELF_BARE.map(phrase => (phrase === 'mato me' || phrase === 'me mato'
    ? { phrase, guardBefore: MATO_NOUN_BEFORE }
    : phrase)),
  ...SUICIDE_SELF_BARE
];

// v2.2 (1.1): infinitivo nu. Só dispara quando o trecho (entre pontuações)
// é só isso, mais até 2 palavras de enchimento. «hoje» entra junto com o
// enchimento por causa do exemplo da própria proposta («me matar hoje»).
// «isto vai matar-me» e «o chefe vai me matar» não disparam.
const BARE_INFINITIVES = ['matar me', 'me matar', 'matar se'];
const BARE_FILLER = [...FILLER, 'hoje'];

// v2.2 (1.2): gatilhos novos, só 1.ª pessoa, só com estes alvos.
const TRIGGERS_V22 = ['hei de', 'devia', 'devo', 'mais vale', 'melhor era', 'talvez devesse'];
const TARGETS_V22 = ['matar me', 'me matar', 'me suicidar'];

// v2.2 (2.2): alvo «ter morrido» com os gatilhos de querer, preferir, dever e «ia».
const TRIGGERS_TER_MORRIDO = [
  'quero', 'queria', 'quis', 'quisesse', 'so quero', 'so queria', 'quer', 'querer', 'querendo', 'quiser',
  'prefiro', 'preferia', 'melhor se eu', 'ia ser melhor eu', 'melhor', 'seria melhor',
  'devia', 'devo', 'talvez devesse',
  'ia'
];

// v2.2 (2.1): palavra de morte + até 4 palavras + expressão de «ir junto».
// «morra» e «morro» viram «mora» e «moro» na normalização (iguais a «morar»):
// essas duas só contam se a nota escrita tiver mesmo «morra»/«morro».
const DEATH_WORDS = ['morreu', 'morreram', 'morrer', 'morra', 'morrerem', 'faleceu', 'falecer'];
const JUNTO_GAP_WORDS = 4;
const JUNTO_GUARD = ['com', 'a', 'ao', 'de', 'da', 'do', 'na', 'no'];
const JUNTO_EXPRESSIONS = [
  ...['e eu junto', 'eu junto', 'eu vou junto', 'vou junto']
    .map(phrase => ({ phrase, level: 'alto', guardNext: JUNTO_GUARD })),
  { phrase: 'eu morro junto', level: 'alto', needsMorro: true },
  { phrase: 'eu morro tambem', level: 'alto', needsMorro: true, guardNext: ['de'] },
  { phrase: 'morro com ele', level: 'alto', needsMorro: true },
  { phrase: 'morro com ela', level: 'alto', needsMorro: true },
  ...['levem me junto', 'leva me junto', 'quero ir junto'].map(phrase => ({ phrase, level: 'alto' })),
  // MÉDIO: «e eu também» só no fim do trecho.
  { phrase: 'e eu tambem', level: 'medio', idea: 'e eu tambem', endOfSegment: true },
  ...['vou atras dele', 'vou atras dela', 'vou atras deles']
    .map(phrase => ({ phrase, level: 'medio', idea: 'vou atras' })),
  ...['devia ter sido eu', 'deveria ter sido eu']
    .map(phrase => ({ phrase, level: 'medio', idea: 'devia ter sido eu' })),
  ...['queria ter ido com ele', 'queria ter ido com ela']
    .map(phrase => ({ phrase, level: 'medio', idea: 'queria ter ido' }))
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
    ['velho', 'velha', 'velhinho', 'velhinha', 'de velhice', 'saudavel', 'em forma']),
  // v2.2 (1.3): «a/de + verbo» e jogo valem só para as formas NOVAS de «matar»
  // da 1.1 ("mato-me a trabalhar", "me matei de estudar"). As formas que já
  // eram alvo depois de gatilho na v2.1 (o infinitivo «me matar/matar-me/
  // matar-se» e os colados «mematar/matarme») ficam com as exceções da v2.1:
  // «vou me matar a trabalhar» e «quero me matar na final» continuam ALTO
  // (achado da revisão do PR 23).
  ...exceptionPairs(
    KILL_SELF_BARE_NEW.flatMap(t => [`${t} de`, `${t} a`]),
    ['rir', 'tanto rir', 'treinar', 'estudar', 'trabalhar', 'correr', 'limpar', 'cozinhar',
      'tanto treinar', 'tanto estudar', 'tanto trabalhar', 'trabalho', 'estudo']
  ),
  ...exceptionPairs(KILL_SELF_BARE_NEW, ['no jogo', 'na partida', 'na fase', 'na final', 'na quadra']),
  // v2.2 (2.2): «ter morrido de rir/vergonha/sono».
  ...exceptionPairs(['morrido de'], ['rir', 'vergonha', 'sono'])
];

// v2.1 (4): «morrer/morreu» até 2 palavras depois de um aparelho ou planta
// ("o celular vai morrer", "a bateria do celular vai morrer hoje").
// Só vale se as palavras do meio forem nenhuma ou desta lista curta, e se o
// resto do trecho (até a pontuação ou o travessão) também for só isso ou
// outro aparelho. Qualquer outra palavra ("o celular faz querer morrer",
// "celular vai morrer e eu junto") faz a exceção não valer: na dúvida, a tela aparece.
const DEVICES = new Set(['celular', 'telefone', 'bateria', 'computador', 'notebook', 'planta', 'plantas']
  .map(normalizeNote));
const DEVICE_DIE = new Set(['morrer', 'morreu'].map(normalizeNote));
const DEVICE_NEUTRAL = new Set(['vai', 'ja', 'do', 'da', 'de', 'meu', 'minha', 'o', 'a', 'hoje', 'agora', 'logo']
  .map(normalizeNote));
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
// Frase repetida entre a lista comum e o padrão: vale a da lista comum.
// Frase que o padrão forma de mais de um jeito: vale o primeiro jeito na
// ordem alvo, gatilho, enchimento (a ordem em que a v2 expandia).
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

function buildTable(plainEntries, families = []) {
  const table = new Map();
  let maxWords = 1;
  for (const entry of plainEntries) {
    const norm = normalizeEntry(typeof entry === 'string' ? entry : normalizeOptions(entry), false);
    if (!norm.phrase || table.has(norm.phrase)) continue;
    norm.order = table.size;
    table.set(norm.phrase, norm);
    if (norm.words > maxWords) maxWords = norm.words;
  }
  const pattern = families.length ? buildPattern(families, table.size) : null;
  const scanWords = pattern ? Math.max(maxWords, pattern.maxWords) : maxWords;
  return { table, maxWords, pattern, scanWords };
}

// ---------- Padrão por partes ----------
// Uma família = uma lista de gatilhos + os alvos que vão com ela.
// Cada alvo ocupava, na tabela expandida, um bloco de
// (gatilhos x enchimentos) posições; "base" é onde o bloco começa.
function firstIndex(list) {
  const out = new Map();
  list.forEach((item, index) => { if (!out.has(item)) out.set(item, index); });
  return out;
}

function wordCount(text) {
  return text ? text.split(' ').length : 0;
}

function buildPattern(families, plainCount) {
  const fillers = fillerSequences().map(normalizeNote);
  const fillerIndex = firstIndex(fillers);
  const fillerWords = Math.max(...fillers.map(wordCount));
  let next = plainCount;
  let maxTrigger = 1;
  let maxTarget = 1;
  const built = families.map(({ forms, targets }) => {
    const formIndex = firstIndex(forms);
    for (const form of forms) maxTrigger = Math.max(maxTrigger, wordCount(form));
    const byTarget = new Map();
    for (const { target, options } of targets) {
      maxTarget = Math.max(maxTarget, wordCount(target));
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push({ base: next, options });
      next += forms.length * fillers.length;
    }
    return { formIndex, byTarget };
  });
  return {
    families: built,
    fillerIndex,
    fillerCount: fillers.length,
    fillerWords,
    maxTrigger,
    maxTarget,
    maxWords: maxTrigger + fillerWords + maxTarget
  };
}

// Todas as formas de ler "words" como gatilho + enchimento + alvo; chama
// visit(posição na tabela expandida, opções do alvo).
function eachParse(pattern, words, visit) {
  const { families, fillerIndex, fillerCount, fillerWords, maxTrigger } = pattern;
  for (let a = 1; a <= maxTrigger && a < words.length; a++) {
    const trigger = words.slice(0, a).join(' ');
    for (const { formIndex, byTarget } of families) {
      const t = formIndex.get(trigger);
      if (t === undefined) continue;
      for (let c = 0; c <= fillerWords && a + c < words.length; c++) {
        const f = fillerIndex.get(words.slice(a, a + c).join(' '));
        if (f === undefined) continue;
        const specs = byTarget.get(words.slice(a + c).join(' '));
        if (!specs) continue;
        for (const { base, options } of specs) visit(base + t * fillerCount + f, options);
      }
    }
  }
}

// A entrada que a tabela expandida guardava para esta frase, ou null.
function lookup({ table, pattern }, phrase) {
  const plain = table.get(phrase);
  if (plain) return plain;
  if (!pattern) return null;
  let best = null;
  eachParse(pattern, phrase.split(' '), (order, options) => {
    if (!best || order < best.order) best = { order, options };
  });
  if (!best) return null;
  const entry = normalizeEntry({ phrase, ...best.options }, true);
  entry.order = best.order;
  return entry;
}

// Fins de frase do padrão que começam em words[0] (só o comprimento em palavras).
function patternLengths(pattern, words) {
  const out = new Set();
  const { families, fillerIndex, fillerWords, maxTrigger, maxTarget } = pattern;
  for (let a = 1; a <= maxTrigger && a < words.length; a++) {
    const trigger = words.slice(0, a).join(' ');
    for (const { formIndex, byTarget } of families) {
      if (!formIndex.has(trigger)) continue;
      for (let c = 0; c <= fillerWords && a + c < words.length; c++) {
        if (!fillerIndex.has(words.slice(a, a + c).join(' '))) continue;
        for (let b = 1; b <= maxTarget && a + c + b <= words.length; b++) {
          if (byTarget.has(words.slice(a + c, a + c + b).join(' '))) out.add(a + c + b);
        }
      }
    }
  }
  return out;
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
function candidates(matcher, tokens, crossSoft) {
  const { table, maxWords, pattern, scanWords } = matcher;
  const found = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (isMark(tokens[i])) continue;
    const words = [];
    for (let k = i; k < tokens.length && words.length < scanWords; k++) {
      if (tokens[k] === HARD) break;
      if (tokens[k] === SOFT) {
        if (crossSoft) continue;
        break;
      }
      words.push(tokens[k]);
    }
    let gram = '';
    for (let n = 1; n <= words.length && n <= maxWords; n++) {
      gram = n === 1 ? words[0] : `${gram} ${words[n - 1]}`;
      const entry = table.get(gram);
      if (entry && !found.has(gram)) found.set(gram, entry);
    }
    if (!pattern) continue;
    for (const n of patternLengths(pattern, words)) {
      const phrase = words.slice(0, n).join(' ');
      if (!found.has(phrase)) found.set(phrase, lookup(matcher, phrase));
    }
  }
  return [...found.values()].sort((a, b) => (b.phrase.length - a.phrase.length) || (a.order - b.order));
}

// Famílias do padrão, na ordem em que a v2 expandia: alvos ALTO (cada um com
// todos os gatilhos, ou só os de 1.ª pessoa), depois outra pessoa; MÉDIO à parte.
function patternFamilies() {
  const n = list => list.map(normalizeNote);
  const allForms = n(TRIGGERS.map(t => t.form));
  const firstForms = n(TRIGGERS.filter(t => t.first).map(t => t.form));
  const otherForms = n(OTHER_TRIGGERS);
  const high = HIGH_TARGETS.map((raw) => {
    const { target, firstPersonOnly, guardBefore, guardAfter } = normalizeOptions(raw);
    return {
      forms: firstPersonOnly ? firstForms : allForms,
      targets: [{ target: normalizeNote(target), options: { guardBefore, guardAfter } }]
    };
  });
  for (const target of n(OTHER_TARGETS)) high.push({ forms: otherForms, targets: [{ target, options: {} }] });
  // v2.2: famílias novas no fim, para as posições da v2.1 não mudarem de ordem.
  const v22Forms = n(TRIGGERS_V22);
  for (const target of n(TARGETS_V22)) high.push({ forms: v22Forms, targets: [{ target, options: {} }] });
  high.push({ forms: n(TRIGGERS_TER_MORRIDO), targets: [{ target: normalizeNote('ter morrido'), options: {} }] });
  const medium = MEDIUM_TARGETS.map((raw) => {
    const { target, idea, guard } = normalizeOptions(raw);
    return { forms: allForms, targets: [{ target: normalizeNote(target), options: { idea, guard } }] };
  });
  return { high: mergeFamilies(high), medium: mergeFamilies(medium) };
}

// Alvos seguidos com a mesma lista de gatilhos ficam na mesma família
// (só para procurar menos; as posições não mudam).
function mergeFamilies(list) {
  const out = [];
  for (const family of list) {
    const last = out[out.length - 1];
    if (last && last.forms === family.forms) last.targets.push(...family.targets);
    else out.push({ forms: family.forms, targets: [...family.targets] });
  }
  return out;
}

const FAMILIES = patternFamilies();

// A v1 vem primeiro: numa frase repetida, valem as regras dela.
const HIGH = buildTable([
  ...HIGH_PHRASES.map((phrase) => {
    if (HIGH_BARE_V1.has(phrase)) return { phrase, ...SELF_HARM_GUARD_BARE };
    if (HIGH_GUARDED_V1.has(phrase)) return { phrase, ...SELF_HARM_GUARD };
    return phrase;
  }),
  ...HIGH_PHRASES_V2,
  ...HIGH_PHRASES_V22
], FAMILIES.high);
const MEDIUM = buildTable(MEDIUM_ENTRIES, FAMILIES.medium);
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

// O trecho em volta de tokens[i..j] (sem atravessar marcador) só tem
// palavras neutras ou aparelhos, fora o próprio "morrer".
function deviceOnlySegment(tokens, i, j) {
  const ok = k => k === j || DEVICES.has(tokens[k]) || DEVICE_NEUTRAL.has(tokens[k]);
  for (let k = i - 1; k >= 0 && !isMark(tokens[k]); k--) if (!ok(k)) return false;
  for (let k = i; k < tokens.length && !isMark(tokens[k]); k++) if (!ok(k)) return false;
  return true;
}

// Corta "aparelho + até 2 palavras neutras + morrer/morreu", pegando o
// aparelho mais perto. Só o próprio trecho sai da nota.
function removeDeviceDeaths(tokens) {
  let out = tokens;
  for (let j = 0; j < out.length; j++) {
    if (!DEVICE_DIE.has(out[j])) continue;
    for (let gap = 0; gap <= DEVICE_GAP_WORDS; gap++) {
      const i = j - gap - 1;
      if (i < 0 || isMark(out[i])) break;
      if (!DEVICES.has(out[i])) continue;
      if (deviceOnlySegment(out, i, j)) {
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

// ---------- v2.2: infinitivo nu ----------
// Sequências de 0 a 2 palavras feitas só de enchimento.
const BARE_FILLER_SEQUENCES = (() => {
  const units = BARE_FILLER.map(normalizeNote);
  const out = new Set(['']);
  for (const a of units) {
    if (wordCount(a) <= 2) out.add(a);
    for (const b of units) if (wordCount(a) + wordCount(b) <= 2) out.add(`${a} ${b}`);
  }
  return out;
})();
const BARE_INFINITIVE_WORDS = BARE_INFINITIVES.map(t => normalizeNote(t).split(' '));

// Algum trecho (entre marcadores) é só o infinitivo + até 2 palavras de enchimento?
function hasBareInfinitive(tokens) {
  let segment = [];
  const check = () => {
    for (const words of BARE_INFINITIVE_WORDS) {
      for (let i = 0; i + words.length <= segment.length; i++) {
        if (!words.every((word, k) => segment[i + k] === word)) continue;
        const before = segment.slice(0, i).join(' ');
        const after = segment.slice(i + words.length).join(' ');
        if (wordCount(before) + wordCount(after) > 2) continue;
        if (BARE_FILLER_SEQUENCES.has(before) && BARE_FILLER_SEQUENCES.has(after)) return true;
      }
    }
    return false;
  };
  for (const token of [...tokens, HARD]) {
    if (!isMark(token)) { segment.push(token); continue; }
    if (check()) return true;
    segment = [];
  }
  return false;
}

// ---------- v2.2: palavra de morte + até 4 palavras + «ir junto» ----------
const DEATH = new Set(DEATH_WORDS.map(normalizeNote));
const MORRA = normalizeNote('morra');
const MORRO = normalizeNote('morro');
const JUNTO = JUNTO_EXPRESSIONS.map(expr => ({
  ...expr,
  words: normalizeNote(expr.phrase).split(' '),
  guardNext: (expr.guardNext || []).map(normalizeNote)
}));

// A nota escrita tem «morra»/«morro» (com dois erres)? Sem isso, «mora»/«moro»
// é do verbo morar e não conta.
function rawHasWord(raw, pattern) {
  const text = String(raw).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return pattern.test(text);
}

// Devolve { alto: bool, ideas: Set } para as expressões de «ir junto».
function juntoMatches(tokens, crossSoft, raw) {
  const out = { alto: false, ideas: new Set() };
  const hasMorra = rawHasWord(raw, /(^|[^a-z])morr+a+([^a-z]|$)/);
  const hasMorro = rawHasWord(raw, /(^|[^a-z])morr+o+([^a-z]|$)/);
  for (let i = 0; i < tokens.length; i++) {
    if (!DEATH.has(tokens[i])) continue;
    if (tokens[i] === MORRA && !hasMorra) continue;
    // Começos possíveis da expressão: até 4 palavras depois, sem atravessar
    // HARD; SOFT só na 2.ª leitura.
    let gap = 0;
    for (let s = i + 1; s < tokens.length && gap <= JUNTO_GAP_WORDS; s++) {
      if (tokens[s] === HARD) break;
      if (tokens[s] === SOFT) {
        if (crossSoft) continue;
        break;
      }
      for (const expr of JUNTO) {
        if (expr.needsMorro && !hasMorro) continue;
        const end = matchAt(tokens, expr.words, s, crossSoft);
        if (end < 0) continue;
        // Guardas e «fim do trecho» olham só a palavra seguinte, sem atravessar pontuação.
        const next = isMark(tokens[end]) ? null : tokens[end];
        if (next && expr.guardNext.includes(next)) continue;
        if (expr.endOfSegment && next) continue;
        if (expr.level === 'alto') out.alto = true;
        else out.ideas.add(expr.idea);
      }
      gap++;
    }
  }
  return out;
}

function classifyTokens(original, crossSoft, raw) {
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

  // v2.2 (2.1): «morreu e eu junto» e afins.
  const junto = juntoMatches(original, crossSoft, raw);
  if (junto.alto) return 'alto';

  // Ideias diferentes, não ocorrências: a mesma ideia repetida conta uma vez.
  const noteWords = original.filter(token => !isMark(token)).join(' ');
  const mediumIdeas = new Set(junto.ideas);
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

// Travessão também corta: – — ― sempre, e o hífen quando tem espaço de um
// lado ("celular - ele"). Hífen colado nas duas pontas ("vou-me") não corta.
const PUNCTUATION_BREAK = /(?:[.!?;…,:\r\n\u2028\u2029\u2013\u2014\u2015]|(?:^|\s)[-\u2010-\u2012\u2212]+|[-\u2010-\u2012\u2212]+(?:\s|$))+/;

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
  // v2.2 (1.1): infinitivo nu sozinho no trecho.
  if (hasBareInfinitive(cleaned)) return 'alto';
  // 1.ª leitura: a pontuação corta tudo. 2.ª leitura: a pontuação não corta
  // as frases de risco (guardas continuam cortadas). Vale o nível mais alto.
  const strict = classifyTokens(cleaned, false, note);
  if (strict === 'alto') return 'alto';
  const loose = classifyTokens(cleaned, true, note);
  return (RANK[loose] || 0) > (RANK[strict] || 0) ? loose : strict;
}

module.exports = {
  classifyNote,
  normalizeNote,
  GUARD_WINDOW_WORDS,
  HIGH_GUARD_WINDOW_WORDS
};
