const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { classifyNote } = require('../lib/crisis-filter');

// O casador por partes tem de dar o MESMO resultado da tabela expandida
// (cópia congelada do PR 21 em referencia/). Os dois módulos são carregados
// com as partes internas expostas, só para este teste.
//
// v2.2: a lista mudou de propósito (frases novas, exceções novas). Por isso
// a comparação passou a ser: (1) a v2.2 nunca fica ABAIXO da v2.1, a não
// ser onde uma exceção nova da v2.2 cortou a nota; (2) toda frase da v2.1
// continua com a mesma entrada; (3) as candidatas da v2.1 continuam lá,
// na mesma ordem, quando as exceções não mudaram a nota.
const REFERENCE = path.join(__dirname, '..', 'referencia', 'crisis-filter-tabela-v2.1.js');
const CURRENT = path.join(__dirname, '..', 'lib', 'crisis-filter.js');

function loadWithInternals(file, names) {
  const source = fs.readFileSync(file, 'utf8');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(`${source}\nmodule.exports.__parts = { ${names.join(', ')} };`, file);
  return loaded.exports;
}

const SHARED = ['HIGH', 'MEDIUM', 'candidates', 'tokenize', 'removeExceptions'];
const reference = loadWithInternals(REFERENCE, [...SHARED, 'TRIGGERS', 'OTHER_TRIGGERS', 'FILLER',
  'HIGH_TARGETS', 'MEDIUM_TARGETS', 'OTHER_TARGETS']);
const current = loadWithInternals(CURRENT, [...SHARED, 'lookup']);
const parts = reference.__parts;
const now = current.__parts;

const OPTION_KEYS = ['phrase', 'words', 'idea', 'guard', 'upgrade', 'guardBefore', 'guardAfter'];
const options = entry => OPTION_KEYS.map(key => entry[key]);

// Gerador fixo (mesmas notas em toda execução).
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

function quotedStrings(file) {
  const out = [];
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    out.push(match[1].replace(/\\n/g, '\n'));
  }
  return out;
}

const MARKS = ['. ', '... ', '\n', ', ', '; ', '! ', ': ', '…', '? '];

function withMarks(note, out) {
  const words = note.split(' ');
  for (let i = 1; i < words.length; i++) {
    for (const mark of MARKS) out.add(words.slice(0, i).join(' ') + mark + words.slice(i).join(' '));
  }
}

let cachedNotes = null;
function buildNotes() {
  if (cachedNotes) return cachedNotes;
  const notes = new Set();

  // 1. Todas as frases do arquivo de casos (secção 4 e regras), e cada uma
  //    com pontuação entre as palavras.
  for (const note of quotedStrings(path.join(__dirname, 'crisis-filter.test.js'))) {
    notes.add(note);
    notes.add(`${note}.`);
    withMarks(note, notes);
  }

  // 2. Todo gatilho com todo alvo (inclusive os que não combinam), com
  //    0, 1 e 2 palavras de enchimento e com contexto antes e depois.
  const rand = prng(20261122);
  const pick = list => list[Math.floor(rand() * list.length)];
  const forms = [...parts.TRIGGERS.map(t => t.form), ...parts.OTHER_TRIGGERS];
  const targets = [
    ...parts.HIGH_TARGETS.map(t => t.target),
    ...parts.MEDIUM_TARGETS.map(t => t.target),
    ...parts.OTHER_TARGETS
  ];
  const before = ['', '', 'eu', 'nao', 'tenho medo de', 'para nao', 'evitar', 'risco de', 'o celular',
    'minha planta', 'ele', 'hoje', 'muito'];
  const after = ['', '', 'de rir', 'de tanto treinar', 'no treino', 'uns dias', 'para sempre', 'em paz',
    'velhinho', 'na academia', 'hoje', 'mais', 'muito'];
  for (const form of forms) {
    for (const target of targets) {
      const fillers = ['', pick(parts.FILLER), `${pick(parts.FILLER)} ${pick(parts.FILLER)}`, 'ver o'];
      for (const filler of fillers) {
        const core = [form, filler, target].filter(Boolean).join(' ');
        notes.add(core);
        notes.add([pick(before), core, pick(after)].filter(Boolean).join(' '));
      }
    }
  }

  // 3. Fuzz: pedaços e palavras soltas das listas, misturados com pontuação.
  const pieces = [...new Set([...quotedStrings(REFERENCE), ...quotedStrings(path.join(__dirname, 'crisis-filter.test.js'))])]
    .filter(piece => piece.trim() && piece.length < 80);
  const loose = [...new Set(pieces.flatMap(piece => piece.split(/\s+/)).filter(Boolean))];
  const joins = [' ', ' ', ' ', ' e ', ', ', '. ', '\n', '... ', ' mas '];
  for (let i = 0; i < 25000; i++) {
    const size = 1 + Math.floor(rand() * 6);
    let note = '';
    for (let k = 0; k < size; k++) {
      const piece = rand() < 0.5 ? pick(pieces) : pick(loose);
      note = k === 0 ? piece : note + pick(joins) + piece;
    }
    if (rand() < 0.2) note = note.toUpperCase();
    notes.add(note);
  }
  cachedNotes = [...notes];
  return cachedNotes;
}

const RANK = { alto: 2, medio: 1 };
const rank = level => RANK[level] || 0;

test('v2.2 nunca fica abaixo da tabela expandida (PR 21), fora das exceções novas', () => {
  const notes = buildNotes();
  assert.ok(notes.length > 50000, `conjunto pequeno demais: ${notes.length}`);
  const lower = [];
  let higher = 0;
  const levels = { alto: 0, medio: 0, nada: 0 };
  for (const note of notes) {
    const expected = reference.classifyNote(note);
    const got = classifyNote(note);
    levels[expected || 'nada']++;
    if (rank(got) > rank(expected)) higher++;
    if (rank(got) >= rank(expected)) continue;
    // Só pode descer se uma exceção nova da v2.2 cortou a nota.
    const tokensRef = parts.removeExceptions(parts.tokenize(note));
    const tokensNow = now.removeExceptions(now.tokenize(note));
    if (JSON.stringify(tokensNow) === JSON.stringify(tokensRef)) lower.push({ note, expected, got });
  }
  // O conjunto precisa ter os três níveis em quantidade, senão o teste não prova nada.
  for (const level of Object.keys(levels)) assert.ok(levels[level] > 1000, `poucos casos ${level}: ${levels[level]}`);
  // As frases novas da v2.2 aparecem no conjunto (senão a comparação não mede nada novo).
  assert.ok(higher > 100, `poucas notas subiram: ${higher}`);
  assert.deepEqual(lower.slice(0, 10), [], `${lower.length} notas desceram sem exceção nova`);
});

// A tabela expandida inteira: cada frase dela é reconhecida por partes com
// as mesmas regras (guardas, ideia) e na mesma ordem de desempate.
test('cada frase da tabela expandida tem a mesma entrada no casador por partes', () => {
  for (const name of ['HIGH', 'MEDIUM']) {
    const table = parts[name].table;
    assert.ok(table.size > (name === 'HIGH' ? 100000 : 10000), `${name}: ${table.size} frases`);
    let lastOrder = -1;
    let checked = 0;
    for (const [phrase, expected] of table) {
      const got = now.lookup(now[name], phrase);
      assert.ok(got, `${name}: falta ${JSON.stringify(phrase)}`);
      assert.deepEqual(options(got), options(expected), `${name}: ${JSON.stringify(phrase)}`);
      // A tabela antiga está na ordem de inserção; a ordem nova tem de crescer junto.
      assert.ok(got.order > lastOrder, `${name}: ordem de ${JSON.stringify(phrase)}`);
      lastOrder = got.order;
      checked++;
    }
    assert.equal(checked, table.size);
  }
});

// As frases candidatas da v2.1 (nas duas leituras) continuam lá, na mesma
// ordem, sempre que as exceções deixam a nota igual. A v2.2 pode somar frases.
test('candidatas da v2.1 continuam, na mesma ordem, em cada nota do conjunto', () => {
  const notes = buildNotes();
  let compared = 0;
  for (const note of notes) {
    const tokensRef = parts.removeExceptions(parts.tokenize(note));
    const tokensNow = now.removeExceptions(now.tokenize(note));
    if (JSON.stringify(tokensNow) !== JSON.stringify(tokensRef)) continue;
    compared++;
    for (const name of ['HIGH', 'MEDIUM']) {
      for (const crossSoft of [false, true]) {
        const ref = parts.candidates(parts[name], tokensRef, crossSoft).map(options);
        const refPhrases = new Set(ref.map(entry => entry[0]));
        const got = now.candidates(now[name], tokensNow, crossSoft).map(options)
          .filter(entry => refPhrases.has(entry[0]));
        if (got.length !== ref.length || got.some((entry, i) => JSON.stringify(entry) !== JSON.stringify(ref[i]))) {
          assert.deepEqual(got, ref, `${name} ${crossSoft}: ${JSON.stringify(note)}`);
        }
      }
    }
  }
  assert.ok(compared > notes.length * 0.9, `poucas notas comparadas: ${compared} de ${notes.length}`);
});
