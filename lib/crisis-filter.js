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
// A lista segue a lista de palavras do conselho (palavras-filtro.md),
// feita com fontes públicas de prevenção (Ministério da Saúde do Brasil,
// SNS 24, CVV, OMS e outras). Termos de método ficam de fora de propósito.
// PRECISA de revisão de um profissional de saúde mental antes de
// pessoas reais usarem o app.
//
// Todas as frases aqui estão escritas como texto comum. Elas passam pela
// mesma normalização da nota quando o módulo é carregado.
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
  ['kero', 'quero']
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
const TRAINING = ['serie', 'treino', 'exercicio', 'prova', 'texto', 'capitulo'];
const TIRED_OF = [
  'treino', 'dieta', 'perna', 'cardio', 'burpee', 'estudo', 'prova', 'calor',
  'fila', 'espera', 'chefe', 'trabalho', 'acordar cedo'
];
const PLACES = ['academia', 'ginasio', 'aula', 'escola', 'faculdade', 'trabalho', 'treino'];
const INJURY = ['lesionei', 'lesao', 'lesionado', 'lesionada'];
const EXERCISE = ['treino', 'serie', 'exercicio', 'academia', 'ginasio'];
const VANISH_BANAL = ['fim de semana', 'uns dias', 'de ferias', 'da rede'];
const VANISH_DEATH = ['morte', 'morrer', 'paz', 'nao volto', 'para sempre'];

const MEDIUM_ENTRIES = [
  // E. Ser um peso / melhor sem mim
  'sou um peso',
  'sou um peso para os outros',
  'sou um peso pra todo mundo',
  'sou um perdedor e um peso para os outros',
  'me sinto um fardo',
  'sinto que sou um fardo',
  'sou um fardo para os outros',
  'os outros vao ser mais felizes sem mim',
  'vao ser mais felizes sem mim',
  'serao mais felizes sem mim',
  'melhor sem mim',
  'depois que eu morrer',
  'vou deixar voces em paz',
  'vou deixar voce em paz',
  'nao valho nada',
  'nao valer para nada',
  'nao valho pra nada',
  // F. Desesperança, sem saída, vida sem sentido
  'nao tenho esperanca',
  'nao tenho esperanca no futuro',
  'sem esperanca',
  'falta de esperanca',
  'nao vejo saida',
  'nao vejo nenhuma saida',
  'nao vejo luz ao fundo do tunel',
  'nao vejo luz no fim do tunel',
  'nao vejo solucao',
  'nao consigo encontrar uma solucao',
  'nao vejo solucao para os problemas',
  'sinto me encurralado',
  'sinto me encurralada',
  'estou encurralado',
  'estou encurralada',
  { phrase: 'nao ha mais nada o que fazer', guard: EXERCISE },
  { phrase: 'nao tem mais o que fazer', guard: EXERCISE },
  'minha vida nao tem sentido',
  'a vida nao tem sentido',
  'nao tenho mais sentido',
  { phrase: 'nao quero estar aqui', guard: PLACES },
  { phrase: 'nao quero mais estar aqui', guard: PLACES },
  { phrase: 'nao consigo continuar', guard: TRAINING },
  'ninguem me entende',
  { phrase: 'nao aguento mais', guard: TIRED_OF },
  { phrase: 'eu nao aguento mais', guard: TIRED_OF },
  { phrase: 'eu nao posso fazer nada', guard: INJURY },
  { phrase: 'vou desaparecer', guard: VANISH_BANAL, upgrade: VANISH_DEATH },
  // Informal
  'to no fundo do poco',
  'to no limite da vida',
  'queria sumir',
  'quero sumir para sempre',
  'quero sumir',
  'nao vejo futuro',
  'ja nao aguento esta vida',
  'to farto da vida',
  'estou farto da vida',
  // Acréscimos do desenvolvedor para os casos de teste da lista (4).
  'mais felizes sem mim',
  'queria desaparecer',
  'quero desaparecer'
];

// ---------- Exceções (3.2), aplicadas antes de tudo ----------
const EXCEPTIONS = [
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

// Quantas palavras depois da frase contam como "colado" para a exceção.
// Janela curta de propósito: na dúvida, a tela aparece (3.3).
const GUARD_WINDOW_WORDS = 5;

function uniqueSortedByLength(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item.phrase || seen.has(item.phrase)) continue;
    seen.add(item.phrase);
    out.push(item);
  }
  // Mais longa primeiro (1.2).
  return out.sort((a, b) => b.phrase.length - a.phrase.length);
}

function prepare(entries) {
  return uniqueSortedByLength(entries.map((entry) => {
    const raw = typeof entry === 'string' ? { phrase: entry } : entry;
    return {
      phrase: normalizeNote(raw.phrase),
      guard: (raw.guard || []).map(normalizeNote),
      upgrade: (raw.upgrade || []).map(normalizeNote)
    };
  }));
}

const HIGH = prepare(HIGH_PHRASES);
const MEDIUM = prepare(MEDIUM_ENTRIES);
const EXCEPT = prepare(EXCEPTIONS);

const CUT = ' | ';

function hasWords(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

// Tira todas as ocorrências das exceções, deixando um corte no lugar,
// para nenhuma frase de risco atravessar a exceção.
function removeExceptions(padded) {
  let text = padded;
  for (const { phrase } of EXCEPT) {
    const needle = ` ${phrase} `;
    while (text.includes(needle)) text = text.replace(needle, CUT);
  }
  return text;
}

function wordsAfter(text, endIndex) {
  return text
    .slice(endIndex)
    .split(' ')
    .filter(word => word && word !== '|')
    .slice(0, GUARD_WINDOW_WORDS)
    .join(' ');
}

function classifyNote(note) {
  if (note == null) return null;
  const normalized = normalizeNote(note);
  if (!normalized) return null;

  let text = removeExceptions(` ${normalized} `);

  for (const { phrase } of HIGH) {
    if (text.includes(` ${phrase} `)) return 'alto';
  }

  let mediumHits = 0;
  for (const { phrase, guard, upgrade } of MEDIUM) {
    const needle = ` ${phrase} `;
    let index = text.indexOf(needle);
    while (index >= 0) {
      const after = wordsAfter(text, index + needle.length);
      const guarded = guard.some(word => hasWords(after, word));
      if (!guarded) {
        if (upgrade.some(word => hasWords(text, word))) return 'alto';
        mediumHits += 1;
      }
      // Some a frase usada, para uma frase mais curta dentro dela não contar de novo.
      text = text.slice(0, index) + CUT + text.slice(index + needle.length);
      index = text.indexOf(needle);
    }
  }

  // Duas ou mais frases MÉDIO na mesma nota valem como ALTO (1.2).
  if (mediumHits >= 2) return 'alto';
  if (mediumHits === 1) return 'medio';
  return null;
}

module.exports = {
  classifyNote,
  normalizeNote,
  GUARD_WINDOW_WORDS
};
