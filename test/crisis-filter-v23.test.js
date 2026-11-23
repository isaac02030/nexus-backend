const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { classifyNote } = require('../lib/crisis-filter');

// Lista v2.3 (proposta de 23/11, aprovada pelo dono do projeto em 23/11).
// Só frases de exemplo, sem termos de método.

const LIB = path.join(__dirname, '..', 'lib', 'crisis-filter.js');
const REFERENCE_V22 = path.join(__dirname, '..', 'referencia', 'crisis-filter-v2.2.js');
const reference = require(REFERENCE_V22);

// Carrega o filtro com as exceções do profissional LIGADAS, só neste teste,
// para provar que o código escrito faz o que a proposta diz. Em produção a
// constante fica false.
function loadWithProfessionalExceptions() {
  const flag = 'const PROFESSIONAL_EXCEPTIONS_ENABLED = false;';
  const source = fs.readFileSync(LIB, 'utf8');
  assert.equal(source.split(flag).length, 2, 'a constante tem de existir uma vez, desligada');
  const loaded = new Module(LIB, module);
  loaded.filename = LIB;
  loaded.paths = Module._nodeModulePaths(path.dirname(LIB));
  loaded._compile(source.replace(flag, 'const PROFESSIONAL_EXCEPTIONS_ENABLED = true;'), LIB);
  return loaded.exports;
}

const all = (notes, level) => {
  for (const note of notes) assert.equal(classifyNote(note), level, note);
};

describe('filtro de crise v2.3 (1): «devia/mereço morrer» e «eu devo morrer»', () => {
  test('ALTO com «eu» antes ou no trecho nu', () => {
    all(['devia morrer', 'Eu devia morrer.', 'deveria morrer', 'acho que eu devia morrer', 'mereço morrer',
      'eu merecia morrer', 'eu mereço morrer hoje', 'Devia morrer agora', 'eu deveria morrer',
      'hoje foi pesado, eu devia morrer de vez', 'merecia morrer.', 'Mereço morrer mesmo'], 'alto');
  });

  test('MÉDIO: «eu devo morrer» só no trecho curto', () => {
    all(['eu devo morrer', 'Eu devo morrer.', 'eu devo morrer hoje', 'treinei. eu devo morrer'], 'medio');
    // Duas ideias MÉDIO diferentes valem ALTO (regra de sempre).
    assert.equal(classifyNote('eu devo morrer. nao vejo saida'), 'alto');
  });

  test('casos negados: outra pessoa, probabilidade e exceções de sempre', () => {
    all(['o vilão devia morrer', 'ele merece morrer', 'vocês deviam morrer de inveja', 'devo morrer velho',
      'devo morrer de calor', 'eu devo morrer de vergonha', 'ela devia morrer de rir',
      'se eu fosse ele devia morrer de vergonha', 'devo morrer cedo', 'devo morrer', 'eu devo morrer tarde',
      'acho que eu devo morrer', 'o personagem merecia morrer no fim', 'eu devia morrer de rir'], null);
  });
});

describe('filtro de crise v2.3 (2): enchimentos de tempo no trecho nu', () => {
  test('ALTO', () => {
    all(['matar-me amanhã', 'me matar esta noite', 'Matar-me hoje à noite.', 'me suicidar amanhã',
      'devia morrer esta noite', 'me matar essa noite', 'matar-me amanha mesmo'], 'alto');
  });

  test('casos negados: palavras de fora no trecho e o teto de enchimento', () => {
    all(['o chefe vai me matar amanhã', 'isto vai matar-me amanhã', 'amanhã tenho prova', 'esta noite tem jogo',
      'o pai vai matar-me amanha', 'vai matar-me', 'me matar hoje à noite nao da'], null);
  });

  test('os enchimentos de tempo não entram no padrão com gatilho (só no trecho nu)', () => {
    // «quero amanha morrer» não existia na v2.2 e continua sem alerta.
    assert.equal(classifyNote('quero amanha morrer'), reference.classifyNote('quero amanha morrer'));
  });
});

describe('filtro de crise v2.3 (4): guarda de «juntar»', () => {
  test('ALTO continua', () => {
    all(['morreu e eu junto', 'morreu. e eu junto.', 'morreu e eu junto tudo acabou', 'morreu e eu junto dele',
      'morreu e eu junto não sei o que fazer', 'morreu e eu junto. as coisas dele'], 'alto');
  });

  test('não dispara com «eu junto» + objeto concreto da lista fechada', () => {
    all(['morreu e eu junto as coisas dele', 'ele morreu e eu junto as coisas dele',
      'ele morreu e eu junto as coisas dele.', 'morreu e eu junto os papéis', 'morreu e eu junto minhas coisas',
      'morreu e eu junto suas fotos', 'ela faleceu e eu junto os documentos',
      'ele morreu e eu junto as roupas do meu pai. amanha volto ao treino'], null);
  });

  test('2.ª leitura do Argos: com risco depois do objeto, a guarda não vale (casos negados)', () => {
    all(['ele morreu e eu junto as coisas dele e vou junto', 'ele morreu e eu junto as coisas dele e vou tambem',
      'ele morreu e eu junto as coisas dele pra ir junto', 'ele morreu e eu junto as coisas dele para o fim',
      'ele morreu e eu junto as fotos e acabo com tudo', 'meu pai morreu e eu junto o dinheiro do funeral'], 'alto');
  });

  test('achados do Argos no PR 31: «vou junto» e objeto fora da lista continuam ALTO (casos negados)', () => {
    all(['ele morreu e eu vou junto um dia', 'se ele morrer eu vou junto uma hora dessas',
      'morreu e eu vou junto uns dias depois', 'minha mãe morreu e eu vou junto o quanto antes',
      'ela morreu e eu vou junto meus dias', 'se ele morrer, eu vou junto o mesmo dia'], 'alto');
    // A mesma coisa com «eu junto»: só objeto concreto da lista cala.
    all(['morreu e eu junto um dia', 'morreu e eu junto o quanto antes', 'morreu e eu junto meus dias',
      'faleceu e eu junto uns documentos', 'morreu e eu vou junto as coisas dele'], 'alto');
    // E as 6 frases eram ALTO na v2.2.
    for (const note of ['ele morreu e eu vou junto um dia', 'se ele morrer, eu vou junto o mesmo dia']) {
      assert.equal(reference.classifyNote(note), 'alto', `v2.2: ${note}`);
    }
  });

  test('a guarda não vale para «eu morro junto» nem atravessa pontuação (casos negados)', () => {
    all(['ele morreu e eu morro junto as vezes', 'morreu e eu junto, as coisas ficam',
      'morreu e eu junto as. coisas', 'morreu e eu. junto as coisas dele', 'morreu e eu, junto os papéis'], 'alto');
  });
});

describe('filtro de crise v2.3 (3): exceções que esperam o profissional', () => {
  const ON = loadWithProfessionalExceptions();
  const TRAINING = ['me matei no treino', 'matei-me na academia hoje', 'me matei na corrida de domingo',
    'matei-me no ginasio'];
  const LAUGH = ['ele morreu de rir e eu junto', 'morreu de tanto rir e eu junto',
    'elas morreram de vergonha e eu junto', 'morreu de sono e eu junto'];

  test('desligadas (padrão): o alerta continua', () => {
    assert.match(fs.readFileSync(LIB, 'utf8'), /\nconst PROFESSIONAL_EXCEPTIONS_ENABLED = false;\n/);
    all([...TRAINING, ...LAUGH], 'alto');
  });

  test('ligadas (só neste teste): calam os casos da proposta', () => {
    for (const note of [...TRAINING, ...LAUGH]) assert.equal(ON.classifyNote(note), null, note);
  });

  test('ligadas: continuam ALTO presente, futuro, pontuação e outra frase de risco (casos negados)', () => {
    for (const note of ['me matei', 'matei-me ontem', 'me matei no jogo de ontem e quero morrer',
      'mato-me na academia', 'me mato no treino', 'vou me matar na academia', 'me matei. no treino',
      'matar-me-ei na academia', 'ele morreu de cancer e eu junto', 'morreu de fome e eu junto',
      'morreu de rir ontem e eu junto', 'faleceu de rir e eu junto', 'morreu de saudade e eu junto',
      'morreu e eu junto', 'morreu de rir. meu pai morreu e eu junto']) {
      assert.equal(ON.classifyNote(note), 'alto', note);
    }
  });
});

describe('filtro de crise v2.3 (5): «matar-me-ei» e «matarei-me» na exceção «a/de + verbo»', () => {
  test('registro: as duas formas ganham a exceção (para o profissional)', () => {
    all(['quero matar-me-ei a estudar', 'matar-me-ei de estudar', 'matarei-me de tanto trabalhar',
      'matarei-me a trabalhar'], null);
  });

  test('sem a exceção, continuam ALTO (casos negados)', () => {
    all(['matar-me-ei', 'matar-me-ei amanha', 'matarei-me esta noite', 'matar-me-ei na academia',
      'quero matar-me-ei e nunca mais voltar', 'me suicidar de tanto trabalhar'], 'alto');
  });

  test('com gatilho, a regressão do PR 23 vale: «vou matar-me a trabalhar» continua ALTO', () => {
    // A proposta listava esta frase como silenciosa; a lista de regressão da
    // v2.1/v2.2 (revisão do PR 23) manda manter ALTO. Vale a regressão.
    assert.equal(classifyNote('vou matar-me a trabalhar'), 'alto');
  });
});

// Regressão fixa: frases que eram ALTO na v2.1/v2.2 continuam ALTO.
const REGRESSION_HIGH = [
  'vou me matar a trabalhar', 'quero matar-me a correr', 'quero me matar a limpar', 'vou me matar a rir',
  'quero me matar na quadra', 'vou me matar na final', 'vou matar-me a cozinhar', 'quero me matar de limpar',
  'ideias de me matar na final', 'quero me matar a serio', 'vou mematar a trabalhar', 'vou me matar hoje',
  'penso em me matar a noite', 'quero me suicidar de tanto trabalhar', 'ele quer se matar a correr',
  'vou-me matar no treino', 'quero morrer a sério', 'tenho vontade de me matar na quadra',
  'Matar-me.', 'matar-me hoje', 'mato-me', 'eu me mato', 'matei-me ontem', 'matar-me-ei', 'hei de matar-me',
  'mais vale matar-me', 'ele matou-se', 'suicidar-me.', 'meu pai morreu e eu junto', 'morreu. E eu junto.',
  'queria ter morrido', 'quero morrer', 'nao quero mais viver', 'me matei no treino', 'mato-me na academia',
  'ele morreu de rir e eu junto'
];

describe('filtro de crise v2.3: regressão e equivalência', () => {
  test('a lista de regressão da v2.1/v2.2 continua ALTO (e era ALTO na v2.2)', () => {
    for (const note of REGRESSION_HIGH) {
      assert.equal(reference.classifyNote(note), 'alto', `v2.2: ${note}`);
      assert.equal(classifyNote(note), 'alto', note);
    }
  });

  // Lista fechada dos objetos aprovados (escrita à mão, não lida do filtro):
  // se o filtro calar qualquer outra coisa, o teste pega.
  const APPROVED_JUNTO = [
    'as coisas', 'minhas coisas', 'suas coisas', 'os papeis', 'meus papeis', 'seus papeis',
    'as roupas', 'minhas roupas', 'suas roupas', 'os pertences', 'meus pertences', 'seus pertences',
    'os documentos', 'meus documentos', 'seus documentos', 'as fotos', 'minhas fotos', 'suas fotos',
    'o dinheiro'
  ].map(object => new RegExp(`(^|[^a-z])eu junto ${object}([^a-z]|$)`));

  test('nunca desce de nível em relação à v2.2, fora da guarda de «juntar» aprovada', () => {
    const notes = buildNotes();
    assert.ok(notes.length > 30000, `conjunto pequeno demais: ${notes.length}`);
    const RANK = { alto: 2, medio: 1 };
    const rank = level => RANK[level] || 0;
    const lower = [];
    let higher = 0;
    let allowed = 0;
    for (const note of notes) {
      const before = reference.classifyNote(note);
      const now = classifyNote(note);
      if (rank(now) > rank(before)) higher++;
      if (rank(now) >= rank(before)) continue;
      const plain = note.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (APPROVED_JUNTO.some(approved => approved.test(plain))) { allowed++; continue; }
      lower.push({ note, before, now });
    }
    assert.deepEqual(lower.slice(0, 10), [], `${lower.length} notas desceram fora da exceção aprovada`);
    assert.ok(higher > 50, `poucas notas subiram (a v2.3 tem de aparecer no conjunto): ${higher}`);
    assert.ok(allowed > 0, 'a guarda de «juntar» tem de aparecer no conjunto');
  });

  test('o filtro carregado ocupa menos de 1 MB de memória', () => {
    // gc() duas vezes antes e depois: uma só deixa lixo da compilação na conta.
    const script = 'gc(); gc(); const a = process.memoryUsage().heapUsed;'
      + ` require(${JSON.stringify(LIB)}); gc(); gc();`
      // A conta fecha antes de tocar em process.stdout (abrir o stream também ocupa memória).
      + ' const usado = process.memoryUsage().heapUsed - a; process.stdout.write(String(usado));';
    const bytes = Number(execFileSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' }));
    assert.ok(bytes > 0 && bytes < 1024 * 1024, `memória do filtro: ${(bytes / 1048576).toFixed(2)} MB`);
  });
});

// Notas para a equivalência: as frases dos arquivos de teste (com pontuação
// entre as palavras) e um fuzz fixo com pedaços delas.
function quotedStrings(file) {
  const out = [];
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) out.push(match[1]);
  return out;
}

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildNotes() {
  const files = ['crisis-filter.test.js', 'crisis-filter-v23.test.js'].map(f => path.join(__dirname, f));
  const pieces = [...new Set(files.flatMap(quotedStrings))].filter(p => p.trim() && p.length < 80);
  const notes = new Set();
  const marks = ['. ', ', ', '\n', '... ', '! '];
  for (const piece of pieces) {
    notes.add(piece);
    const words = piece.split(' ');
    for (let i = 1; i < words.length; i++) {
      for (const mark of marks) notes.add(words.slice(0, i).join(' ') + mark + words.slice(i).join(' '));
    }
  }
  const loose = [...new Set(pieces.flatMap(p => p.split(/\s+/)).filter(Boolean)),
    'amanha', 'esta noite', 'hoje a noite', 'devia', 'mereco', 'eu', 'junto', 'as', 'os', 'minhas'];
  const joins = [' ', ' ', ' e ', ', ', '. ', '\n'];
  const rand = prng(20261123);
  const pick = list => list[Math.floor(rand() * list.length)];
  for (let i = 0; i < 20000; i++) {
    const size = 1 + Math.floor(rand() * 5);
    let note = '';
    for (let k = 0; k < size; k++) {
      const piece = rand() < 0.5 ? pick(pieces) : pick(loose);
      note = k === 0 ? piece : note + pick(joins) + piece;
    }
    notes.add(note);
  }
  return [...notes];
}
