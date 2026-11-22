const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyNote, normalizeNote } = require('../lib/crisis-filter');

// Casos de teste da lista de palavras do conselho (secção 4).
// 4.1 a 4.3 são os da v1 (regressão); 4.4 a 4.6 são os da v2.
// Frases inventadas e genéricas, sem dados de ninguém.
const HIGH_CASES = [
  'nao quero mais viver',
  'vou me matar',
  'Vou-me matar.',
  'quero morrer',
  'e inutil tentar fazer algo para mudar, eu so quero me matar',
  'n aguento mais viver assim',
  'queria poder dormir e nunca mais acordar',
  'to pensando em acabar com a minha vida',
  'a minha vida nao tem sentido',
  'quero me machucar de proposito',
  'escrevi um bilhete suicida',
  'preferia estar morto'
];

const MEDIUM_CASES = [
  'os outros iam ser mais felizes sem mim',
  'sinto que sou um fardo para os outros',
  'nao vejo saida',
  'ja nao tenho esperanca no futuro',
  'queria desaparecer',
  'sou um peso pra todo mundo',
  'nao aguento mais',
  'nao quero mais estar aqui'
];

// A secção 4 lista estas duas como MÉDIO, mas a secção 2.1 da mesma lista
// as põe em ALTO. Fica o nível mais protetor (ALTO) até a lista ser revista.
const MEDIUM_CASES_LISTED_AS_HIGH = [
  'estou cansado da vida',
  'estariam melhor se eu desaparecesse'
];

const SILENT_CASES = [
  'matei a aula hoje',
  'matei o treino',
  'matei a fome depois da academia',
  'to morto depois do treino',
  'morri de rir',
  'vou me matar de treinar',
  'me mato de estudar nessa semana',
  'pior treino da vida',
  'desisti do treino no meio',
  'vou cortar o acucar',
  'cortei o cabelo',
  'quebrei o recorde',
  'matar a saudade da família',
  'estou morto de sono',
  'hoje o cardio me matou',
  'nao aguentei o treino pesado e desisti no meio',
  'nao consigo continuar a serie',
  'nao aguento mais esse treino de perna'
];

describe('filtro de crise: normalização (1.1)', () => {
  test('exemplos da lista', () => {
    assert.equal(normalizeNote('N aguento mais viver assim.'), normalizeNote('nao aguento mais viver assim'));
    assert.equal(normalizeNote('Vou-me matar.'), 'vou me matar');
    assert.equal(normalizeNote('to mt cansado da vida'), 'estou muito cansado da vida');
    assert.equal(normalizeNote('queria dormir e nunca mais acordar!!!'), 'queria dormir e nunca mais acordar');
  });

  test('acentos, ç, maiúsculas, emoji e letras repetidas', () => {
    assert.equal(normalizeNote('NÃO AGÜENTO 😢'), 'nao aguento');
    assert.equal(normalizeNote('esperança'), 'esperanca');
    assert.equal(normalizeNote('mataaaar'), normalizeNote('matar'));
  });

  test('abreviação só como palavra inteira', () => {
    assert.equal(normalizeNote('n'), 'nao');
    assert.equal(normalizeNote('ano'), 'ano');
    assert.equal(normalizeNote('num dia'), 'num dia');
  });
});

describe('filtro de crise: casos da secção 4', () => {
  for (const note of HIGH_CASES) {
    test(`ALTO: ${note}`, () => assert.equal(classifyNote(note), 'alto'));
  }
  for (const note of MEDIUM_CASES) {
    test(`MÉDIO: ${note}`, () => assert.equal(classifyNote(note), 'medio'));
  }
  for (const note of MEDIUM_CASES_LISTED_AS_HIGH) {
    test(`não passa em silêncio (ALTO pela 2.1): ${note}`, () => assert.equal(classifyNote(note), 'alto'));
  }
  for (const note of SILENT_CASES) {
    test(`não dispara: ${note}`, () => assert.equal(classifyNote(note), null));
  }
});

describe('filtro de crise: regras de match (1.2) e exceções (3)', () => {
  test('palavra solta não dispara', () => {
    for (const word of ['matar', 'morrer', 'morto', 'cortar', 'desistir', 'acabar', 'plano', 'carta', 'sumir', 'peso', 'fardo', 'limite', 'cansado']) {
      assert.equal(classifyNote(word), null, word);
    }
  });

  test('limite de palavra: não dispara dentro de outra palavra', () => {
    assert.equal(classifyNote('rematar o projeto'), null);
    assert.equal(classifyNote('vou me matarrrr'), 'alto');
    assert.equal(classifyNote('quero morrerzinho'), null);
  });

  test('exceção não esconde outra frase de risco na mesma nota', () => {
    assert.equal(classifyNote('morri de rir hoje, mas no fundo quero morrer'), 'alto');
    assert.equal(classifyNote('quero me cortar o cabelo'), null);
    assert.equal(classifyNote('quero me cortar'), 'alto');
  });

  test('"nao aguento mais" com treino não dispara, com a vida é ALTO', () => {
    assert.equal(classifyNote('nao aguento mais a dieta'), null);
    assert.equal(classifyNote('nao aguento mais a vida'), 'alto');
    assert.equal(classifyNote('n aguento mais viver'), 'alto');
  });

  test('duas frases MÉDIO na mesma nota valem ALTO', () => {
    assert.equal(classifyNote('nao vejo saida e ninguem me entende'), 'alto');
  });

  test('frase MÉDIO dentro de outra mais longa conta uma vez só', () => {
    assert.equal(classifyNote('nao tenho esperanca no futuro'), 'medio');
    assert.equal(classifyNote('sou um peso para os outros'), 'medio');
  });

  test('"vou desaparecer": banal não dispara, sozinho MÉDIO, com morte ALTO', () => {
    assert.equal(classifyNote('vou desaparecer uns dias'), null);
    assert.equal(classifyNote('vou desaparecer'), 'medio');
    assert.equal(classifyNote('vou desaparecer para sempre'), 'alto');
    assert.equal(classifyNote('vou desaparecer, so quero paz'), 'alto');
  });

  test('nota vazia, ausente ou de outro tipo', () => {
    assert.equal(classifyNote(undefined), null);
    assert.equal(classifyNote(null), null);
    assert.equal(classifyNote(''), null);
    assert.equal(classifyNote('   '), null);
    assert.equal(classifyNote(42), null);
    assert.equal(classifyNote('fiz 30 minutos de leitura'), null);
  });
});

// ---------- v2 (4.4 a 4.6) ----------
const HIGH_CASES_V2 = [
  'o dia de hoje me fez querer me matar',
  'isso me fez querer me matar',
  'queria me matar',
  'quis me matar ontem',
  'quero muito me matar',
  'eu so quero morrer',
  'queria poder morrer',
  'to com vontade de morrer',
  'da vontade de me matar',
  'penso em me matar todo dia',
  'pensar em me matar',
  'pensando em morrer',
  'pensei em me suicidar',
  'tenho pensado em morrer',
  'ideias de me matar',
  'pensamentos suicidas',
  'queria ter coragem de me matar',
  'ja tentei me matar uma vez',
  'decidi me matar',
  'prefiro morrer',
  'seria melhor se eu morresse',
  'nao queria mais viver',
  'nao aguento viver assim',
  'cansei de viver',
  'nao quero estar vivo',
  'querendo me matar',
  'estou a pensar em matar-me',
  'ando a pensar em matar-me',
  'apetece-me morrer',
  'dá-me vontade de me matar',
  'queria matar-me',
  'queria dar fim à minha vida',
  'quem me dera morrer',
  'kero me matar',
  'keria morrer',
  'pensano em me matar',
  'QUERO ME MATAAARRR!!!',
  'vou me mata',
  'queria morre',
  'quero me matr',
  'vou mematar',
  'meu amigo quer se matar',
  'ela disse que vai se suicidar',
  'ele quer morrer',
  // Negação e exagero disparam de propósito (3.2.1).
  'nao quero me matar',
  'nunca pensei em me matar',
  'nao quero morrer cedo',
  'o treino me fez querer me matar'
];

const MEDIUM_CASES_V2 = [
  'vontade de sumir',
  'me fez querer sumir',
  'penso em desaparecer',
  'queria nao existir',
  'queria nao ter nascido',
  'queria nao acordar amanha',
  'quero acabar com tudo',
  'e se eu morresse'
];

// Previstos pela lista (4.5) que a própria lista não cobre. A lista não foi
// mudada: o caso fica visível aqui até a autora da lista decidir.
const MEDIUM_CASES_V2_NOT_COVERED = [
  {
    note: 'desisti da vida',
    why: 'o alvo da 2.3.3 é "desistir da vida" (infinitivo) depois de um gatilho; "desisti" sem gatilho não está em nenhuma tabela'
  }
];

const SILENT_CASES_V2 = [
  'vou me matar de tanto rir',
  'queria me matar de tanto treinar',
  'quero me matar de estudar essa semana',
  'me fez querer morrer de vergonha',
  'tenho vontade de morrer de rir',
  'queria morrer de sono',
  'queria estar morto de cansaco',
  'penso em me matar de trabalhar mas vou ate o fim',
  'quero sumir da internet por uns dias',
  'vontade de sumir no fim de semana',
  'penso em desaparecer das redes sociais',
  'os dois vao se matar de tanto treinar',
  'morri no jogo de novo',
  'prefiro morrer a correr hoje',
  'vou me cortar do acucar',
  'quero morrer velhinho e saudavel',
  'tenho medo de me machucar no treino',
  'isso me mata de rir',
  'esse treino me mata',
  'quero matar a fome',
  'queria matar a saudade',
  'matei a aula',
  'tenho medo de morrer de infarto',
  'o personagem morre no final do filme'
];

describe('filtro de crise v2: casos da secção 4 (4.4 a 4.6)', () => {
  for (const note of HIGH_CASES_V2) {
    test(`ALTO: ${note}`, () => assert.equal(classifyNote(note), 'alto'));
  }
  for (const note of MEDIUM_CASES_V2) {
    test(`MÉDIO: ${note}`, () => assert.equal(classifyNote(note), 'medio'));
  }
  for (const { note, why } of MEDIUM_CASES_V2_NOT_COVERED) {
    test(`MÉDIO previsto, não coberto pela lista: ${note}`, { todo: why }, () => {
      assert.equal(classifyNote(note), 'medio');
    });
  }
  for (const note of SILENT_CASES_V2) {
    test(`não dispara: ${note}`, () => assert.equal(classifyNote(note), null));
  }
});

describe('filtro de crise v2: regras do padrão (2.3, 2.4, 3.2.1)', () => {
  test('enchimento: até 2 palavras da lista; outra palavra no meio quebra', () => {
    assert.equal(classifyNote('quero muito mesmo me matar'), 'alto');
    assert.equal(classifyNote('queria de verdade morrer'), 'alto');
    assert.equal(classifyNote('quero muito mesmo agora me matar'), null);
    assert.equal(classifyNote('quero ver o filme e morrer de rir'), null);
  });

  test('«r» caído e letra trocada só valem depois de gatilho', () => {
    assert.equal(classifyNote('me mata'), null);
    assert.equal(classifyNote('isso me mata'), null);
    assert.equal(classifyNote('esse calor me mata'), null);
    assert.equal(classifyNote('me matr'), null);
    assert.equal(classifyNote('more'), null);
    assert.equal(classifyNote('o personagem morre'), null);
    assert.equal(classifyNote('quero me suicida'), 'alto');
    assert.equal(classifyNote('pensei em me sucidar'), 'alto');
  });

  test('alvo sozinho, sem gatilho, não dispara', () => {
    for (const note of ['me matar', 'morrer', 'sumir', 'desaparecer', 'estar morto', 'nao existir', 'acabar com tudo']) {
      assert.equal(classifyNote(note), null, note);
    }
  });

  test('«acabar com a vida» só depois de gatilho em 1.ª pessoa', () => {
    assert.equal(classifyNote('o trabalho acaba com a vida de qualquer um'), null);
    assert.equal(classifyNote('isso vai acabar com a vida dele'), null);
    assert.equal(classifyNote('pensar em acabar com a vida'), null);
    assert.equal(classifyNote('quero acabar com a vida'), 'alto');
    assert.equal(classifyNote('to pensando em acabar com a vida'), 'alto');
    assert.equal(classifyNote('me fez querer acabar com a vida'), 'alto');
    // A frase da v1 com "minha" continua valendo sozinha.
    assert.equal(classifyNote('acabar com a minha vida'), 'alto');
  });

  test('guarda no ALTO: me machucar, me magoar, me ferir, me cortar', () => {
    assert.equal(classifyNote('tenho medo de me machucar no treino'), null);
    assert.equal(classifyNote('cuidado para nao me magoar'), null);
    assert.equal(classifyNote('vou me machucar na academia'), null);
    assert.equal(classifyNote('quero me machucar'), 'alto');
    assert.equal(classifyNote('vou me cortar'), 'alto');
    assert.equal(classifyNote('quero me ferir'), 'alto');
    assert.equal(classifyNote('vontade de me magoar'), 'alto');
    assert.equal(classifyNote('quero me machucar de proposito'), 'alto');
  });

  test('guarda no ALTO é colada: treino longe da frase não esconde', () => {
    assert.equal(classifyNote('quero me machucar, depois vou ao treino'), 'alto');
    assert.equal(classifyNote('tenho medo de me machucar no treino, mas no fundo quero morrer'), 'alto');
  });

  test('guarda nunca vale para "nao aguento mais viver", "quero morrer" nem outra pessoa', () => {
    assert.equal(classifyNote('nao aguento mais viver no treino'), 'alto');
    assert.equal(classifyNote('quero morrer no treino'), 'alto');
    assert.equal(classifyNote('ele quer se matar na academia'), 'alto');
  });

  test('exceção por padrão não esconde outra frase de risco na nota', () => {
    assert.equal(classifyNote('morri de rir, mas queria me matar'), 'alto');
    assert.equal(classifyNote('vou me cortar do acucar e quero me cortar'), 'alto');
    assert.equal(classifyNote('quero sumir da internet e queria nao existir'), 'medio');
  });

  test('outra pessoa, filme e livro: ALTO, sem exceção', () => {
    assert.equal(classifyNote('o personagem quis se matar'), 'alto');
    assert.equal(classifyNote('ele ameacou se matar'), 'alto');
    assert.equal(classifyNote('ela ja tentou tirar a propria vida'), 'alto');
    assert.equal(classifyNote('meu amigo fala em suicidar-se'), 'alto');
  });

  test('"2 MÉDIO = ALTO" conta ideias, não repetições', () => {
    assert.equal(classifyNote('queria sumir. quero sumir. vou sumir'), 'medio');
    assert.equal(classifyNote('vontade de sumir, vontade de desaparecer'), 'medio');
    assert.equal(classifyNote('nao aguento mais, nao aguento mais'), 'medio');
    assert.equal(classifyNote('vontade de sumir e nao vejo saida'), 'alto');
    assert.equal(classifyNote('queria nao existir e ninguem me entende'), 'alto');
  });

  test('"me fez querer sumir" conta uma vez só (frase dentro de outra)', () => {
    assert.equal(classifyNote('isso me fez querer sumir'), 'medio');
  });

  test('nota longa responde rápido (o padrão vira tabela ao carregar)', () => {
    const longNote = 'hoje fiz o treino de perna e estou cansado mas feliz '.repeat(40);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) classifyNote(longNote);
    const msEach = Number(process.hrtime.bigint() - start) / 1e6 / 50;
    assert.ok(msEach < 50, `${msEach} ms por nota`);
  });
});

describe('filtro de crise v2: pontuação corta (revisão do PR)', () => {
  test('ponto, !, ?, ; e quebra de linha: exceção não cola na frase seguinte', () => {
    assert.equal(classifyNote('quero me matar. o jogo foi ruim'), 'alto');
    assert.equal(classifyNote('quero morrer. saudavel foi o dia'), 'alto');
    assert.equal(classifyNote('quero morrer! em forma estou'), 'alto');
    assert.equal(classifyNote('quero me matar; de rir nada'), 'alto');
    assert.equal(classifyNote('quero morrer?\nvelho como sempre'), 'alto');
    assert.equal(classifyNote('queria me matar… de rir nada'), 'alto');
  });

  test('pontuação forte: guarda não cola na frase seguinte', () => {
    assert.equal(classifyNote('quero me machucar. Treino hoje foi ruim'), 'alto');
    assert.equal(classifyNote('vou me cortar!\nacademia amanha'), 'alto');
  });

  test('vírgula e dois-pontos também cortam exceções e guardas', () => {
    assert.equal(classifyNote('quero morrer, velho amigo'), 'alto');
    assert.equal(classifyNote('vou me matar, de rir nada tem'), 'alto');
    assert.equal(classifyNote('quero me machucar, treino foi ruim'), 'alto');
    assert.equal(classifyNote('quero morrer: saudavel ou nao'), 'alto');
  });

  test('vírgula não esconde uma frase de risco que a atravessa', () => {
    assert.equal(classifyNote('quero, muito, me matar'), 'alto');
  });

  test('guarda MÉDIO (sumir) também para no corte', () => {
    assert.equal(classifyNote('quero sumir. uns dias assim e pronto'), 'medio');
    assert.equal(classifyNote('quero sumir, uns dias assim'), 'medio');
    assert.equal(classifyNote('quero sumir uns dias'), null);
  });

  test('"medo de" só guarda o alvo colado, sem gatilho no meio', () => {
    assert.equal(classifyNote('tenho medo de querer me machucar'), 'alto');
    assert.equal(classifyNote('tenho medo de vontade de me magoar'), 'alto');
    assert.equal(classifyNote('tenho medo de me machucar'), null);
    assert.equal(classifyNote('tenho medo de me machucar no treino'), null);
  });

  test('os "não dispara" com pontuação continuam calados', () => {
    assert.equal(classifyNote('Tenho medo de me machucar no treino.'), null);
    assert.equal(classifyNote('Vou me matar de rir!'), null);
    assert.equal(classifyNote('isso me mata de rir. esse treino me mata.'), null);
    assert.equal(classifyNote('Quero morrer velhinho e saudável.'), null);
    assert.equal(classifyNote('quero sumir da internet, por uns dias'), null);
  });

  test('todos os casos da secção 4 com ponto final dão o mesmo resultado', () => {
    for (const note of [...HIGH_CASES, ...HIGH_CASES_V2]) assert.equal(classifyNote(`${note}.`), 'alto', note);
    for (const note of [...MEDIUM_CASES, ...MEDIUM_CASES_V2]) assert.equal(classifyNote(`${note}.`), 'medio', note);
    for (const note of [...SILENT_CASES, ...SILENT_CASES_V2]) assert.equal(classifyNote(`${note}.`), null, note);
  });
});

describe('filtro de crise v2: pontuação não cala frase de risco (2.ª revisão do PR)', () => {
  test('pontuação no meio da frase de risco: dispara', () => {
    assert.equal(classifyNote('nao quero mais. viver'), 'alto');
    assert.equal(classifyNote('quero. me matar'), 'alto');
    assert.equal(classifyNote('quero\nmorrer'), 'alto');
    assert.equal(classifyNote('nao aguento mais... viver assim'), 'alto');
  });

  test('os casos da 1.ª revisão continuam disparando', () => {
    const notes = [
      'quero me machucar. Treino hoje foi ruim',
      'quero me matar. o jogo foi ruim',
      'quero morrer. saudavel foi o dia',
      'quero morrer, velho amigo',
      'tenho medo de querer me machucar',
      'quero me matar; de rir nada',
      'quero morrer! em forma estou',
      'quero, muito, me matar'
    ];
    for (const note of notes) assert.equal(classifyNote(note), 'alto', note);
  });

  test('exceções e guardas continuam sem atravessar a pontuação', () => {
    assert.equal(classifyNote('Tenho medo de me machucar no treino.'), null);
    assert.equal(classifyNote('evitar me machucar'), null);
    assert.equal(classifyNote('Vou me matar de rir!'), null);
    assert.equal(classifyNote('quero sumir uns dias'), null);
    assert.equal(classifyNote('quero sumir. uns dias assim'), 'medio');
    assert.equal(classifyNote('quero. morrer de rir'), null);
  });

  // Níveis do commit 7419b6b (antes de a pontuação virar corte): nele a
  // pontuação sumia, então cada variante tinha o nível da nota sem pontuação,
  // que é o nível esperado de cada caso da secção 4 (conferido rodando o
  // 7419b6b nas mesmas variantes). Nenhuma variante pode cair de nível.
  test('casos da secção 4 com pontuação entre as palavras não caem de nível', () => {
    const RANK = { alto: 2, medio: 1 };
    const cases = [
      ...[...HIGH_CASES, ...HIGH_CASES_V2, ...MEDIUM_CASES_LISTED_AS_HIGH].map(note => [note, 'alto']),
      ...[...MEDIUM_CASES, ...MEDIUM_CASES_V2].map(note => [note, 'medio']),
      ...[...SILENT_CASES, ...SILENT_CASES_V2].map(note => [note, null])
    ];
    const marks = ['. ', '... ', '\n', ', ', '; ', '! ', ': ', '…'];
    for (const [note, level] of cases) {
      const words = note.split(' ');
      for (let i = 1; i < words.length; i++) {
        for (const mark of marks) {
          const variant = words.slice(0, i).join(' ') + mark + words.slice(i).join(' ');
          const got = classifyNote(variant);
          assert.ok((RANK[got] || 0) >= (RANK[level] || 0), `${JSON.stringify(variant)}: ${got} < ${level}`);
        }
      }
    }
  });
});
