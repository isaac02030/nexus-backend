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
  'o treino me fez querer me matar',
  // v2.1 (2, 3, 5)
  'ele quer muito se matar',
  'to pensando em acabar com a vida',
  'estava com vontade de morrer',
  'ela ia me matar se eu chegasse tarde'
];

const MEDIUM_CASES_V2 = [
  'vontade de sumir',
  'me fez querer sumir',
  'penso em desaparecer',
  'queria nao existir',
  'queria nao ter nascido',
  'queria nao acordar amanha',
  'quero acabar com tudo',
  'e se eu morresse',
  // v2.1 (1): antes ficava como caso previsto e não coberto.
  'desisti da vida',
  'desisti de viver'
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
  'o personagem morre no final do filme',
  // v2.1 (4)
  'o celular vai morrer',
  'a bateria do celular vai morrer hoje',
  'desisti do treino'
];

describe('filtro de crise v2: casos da secção 4 (4.4 a 4.6)', () => {
  for (const note of HIGH_CASES_V2) {
    test(`ALTO: ${note}`, () => assert.equal(classifyNote(note), 'alto'));
  }
  for (const note of MEDIUM_CASES_V2) {
    test(`MÉDIO: ${note}`, () => assert.equal(classifyNote(note), 'medio'));
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

  // «me matar» sozinho no trecho passou a disparar na v2.2 (ver os testes da v2.2).
  test('alvo sozinho, sem gatilho, não dispara', () => {
    for (const note of ['morrer', 'sumir', 'desaparecer', 'estar morto', 'nao existir', 'acabar com tudo']) {
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
  // Casos novos da v2.1: o nível esperado é o da nota sem pontuação.
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

describe('filtro de crise v2.1: ajustes da lista', () => {
  test('«desisti da vida/de viver» são MÉDIO; «desisti» sozinho e as exceções não disparam', () => {
    assert.equal(classifyNote('desisti da vida'), 'medio');
    assert.equal(classifyNote('eu ja desisti de viver'), 'medio');
    assert.equal(classifyNote('desisti'), null);
    assert.equal(classifyNote('desisti do treino'), null);
    assert.equal(classifyNote('desisti da dieta'), null);
  });

  test('«desisti da vida» e «desistir de viver» são a mesma ideia; com outra ideia é ALTO', () => {
    assert.equal(classifyNote('desisti da vida e quero desistir de viver'), 'medio');
    assert.equal(classifyNote('desisti da vida e nao vejo saida'), 'alto');
  });

  test('gatilhos em 1.ª pessoa com estou/estava e me fez/faz/fazia querer', () => {
    for (const note of [
      'estou pensando em acabar com a vida',
      'estava pensando em acabar com a vida',
      'estou querendo acabar com a vida',
      'estava com vontade de acabar com a vida',
      'me fez querer acabar com a vida',
      'me faz querer acabar com a vida',
      'me fazia querer acabar com a vida',
      'me fez ter vontade de acabar com a vida'
    ]) assert.equal(classifyNote(note), 'alto', note);
  });

  test('enchimento também nas frases sobre outra pessoa', () => {
    assert.equal(classifyNote('ele quer muito se matar'), 'alto');
    assert.equal(classifyNote('ela quer mesmo morrer'), 'alto');
    assert.equal(classifyNote('ele ja tentou de verdade se matar'), 'alto');
    assert.equal(classifyNote('ele quer muito mesmo agora se matar'), null);
  });

  test('aparelho ou planta + até 2 palavras neutras + morrer/morreu não dispara', () => {
    for (const note of [
      'o celular vai morrer',
      'a bateria do celular vai morrer hoje',
      'minha planta morreu',
      'meu telefone ja vai morrer',
      'o notebook vai morrer',
      'a planta morreu hoje',
      'o celular vai morrer. vou carregar'
    ]) assert.equal(classifyNote(note), null, note);
  });

  test('palavra fora da lista neutra, no meio ou no trecho, faz a exceção não valer (revisão do PR)', () => {
    for (const note of [
      'o celular faz querer morrer',
      'celular ele quer morrer',
      'celular - ele quer morrer',
      'celular – ele quer morrer',
      'celular — ele quer morrer',
      'o celular melhor morrer',
      'o celular vou querer morrer',
      'celular vai morrer e eu junto',
      'suicidar-se o celular vai morrer',
      'o computador quer morrer'
    ]) assert.equal(classifyNote(note), 'alto', note);
  });

  test('travessão corta; hífen dentro da palavra não', () => {
    assert.equal(classifyNote('quero morrer - de rir nada'), 'alto');
    assert.equal(classifyNote('quero morrer — velho amigo'), 'alto');
    assert.equal(classifyNote('quero morrer –\nsaudavel'), 'alto');
    assert.equal(classifyNote('Vou-me matar.'), 'alto');
    assert.equal(classifyNote('queria matar-me'), 'alto');
    assert.equal(classifyNote('vou-me matar de rir'), null);
  });

  test('a exceção do aparelho não esconde frase de risco', () => {
    // Mais de 2 palavras entre o aparelho e "morrer": a exceção não vale.
    assert.equal(classifyNote('o celular do meu pai vai morrer'), 'alto');
    // Pontuação corta a exceção.
    assert.equal(classifyNote('o celular, quero morrer'), 'alto');
    assert.equal(classifyNote('perdi o celular. vou morrer'), 'alto');
    // Gatilho em 1.ª pessoa logo antes de "morrer": a exceção não vale.
    assert.equal(classifyNote('larguei o celular e quero morrer'), 'alto');
    assert.equal(classifyNote('celular quero morrer'), 'alto');
    // Outra frase de risco na mesma nota.
    assert.equal(classifyNote('o celular vai morrer e eu quero morrer'), 'alto');
    assert.equal(classifyNote('minha planta morreu, queria me matar'), 'alto');
  });

  test('«ela ia me matar se eu chegasse tarde» continua disparando (por design)', () => {
    assert.equal(classifyNote('ela ia me matar se eu chegasse tarde'), 'alto');
  });
});

// v2.2: casos da proposta (secção 4) e um caso negado para cada termo novo.
// Frases inventadas e genéricas, sem dados de ninguém.
describe('filtro de crise v2.2: «matar-me» sozinho (1.1 a 1.3)', () => {
  test('casos 4.1 da proposta disparam ALTO', () => {
    for (const note of [
      'Matar-me.', 'matar-me hoje', 'mato-me', 'eu me mato', 'matei-me ontem', 'matar-me-ei',
      'hei de matar-me', 'mais vale matar-me', 'ele matou-se', 'matarme', 'mematar', 'suicidar-me.',
      'nao me mato', 'nunca me matei'
    ]) assert.equal(classifyNote(note), 'alto', note);
  });

  test('cada forma nova da 1.1 dispara sozinha', () => {
    for (const note of [
      'mato-me', 'me mato', 'matei-me', 'me matei', 'matar-me-ei', 'matarei-me',
      'matou-se', 'se matou', 'mataram-se', 'se mataram', 'mematar', 'matarme',
      'mesuicidar', 'suicidarme', 'suicidar-me', 'me suicidar', 'me suicidei', 'suicidei-me'
    ]) {
      assert.equal(classifyNote(note), 'alto', note);
      assert.equal(classifyNote(`hoje ${note} de novo.`), 'alto', `no meio: ${note}`);
    }
  });

  test('infinitivo nu só dispara quando o trecho é só ele (+ até 2 palavras de enchimento)', () => {
    for (const note of ['Matar-me.', 'me matar', 'Matar-se?', 'me matar hoje', 'so matar-me', 'me matar de vez',
      'o dia foi longo. Matar-me.', 'cansei, me matar mesmo']) {
      assert.equal(classifyNote(note), 'alto', note);
    }
  });

  test('infinitivo nu com outras palavras no trecho não dispara (casos negados)', () => {
    for (const note of [
      'isto vai matar-me', 'o pai vai matar-me se descobrir', 'o chefe vai me matar',
      'a minha mae vai matar-me', 'ele vai matar-se de rir', 'me matar hoje nao da tempo',
      'so me matar de vez mesmo'
    ]) assert.equal(classifyNote(note), null, note);
  });

  test('gatilhos novos (1.2) com «matar-me», «me matar» e «me suicidar»', () => {
    for (const trigger of ['hei de', 'devia', 'devo', 'mais vale', 'melhor era', 'talvez devesse']) {
      for (const target of ['matar-me', 'me matar', 'me suicidar']) {
        assert.equal(classifyNote(`${trigger} ${target} amanha`), 'alto', `${trigger} ${target}`);
        assert.equal(classifyNote(`${trigger} mesmo ${target} amanha`), 'alto', `${trigger} mesmo ${target}`);
      }
    }
  });

  test('gatilhos novos não pegam outros alvos nem frase sem alvo (casos negados)', () => {
    for (const note of [
      'devia treinar mais', 'devo estudar hoje', 'hei de conseguir', 'mais vale tarde que nunca',
      'melhor era ter ido', 'talvez devesse descansar', 'devia sumir uns dias',
      'devo ver o me matar amanha'
    ]) assert.equal(classifyNote(note), null, note);
  });

  test('exceções «a/de + verbo» e jogo valem para as formas de «matar» (casos 4.3)', () => {
    for (const note of [
      'mato-me a trabalhar', 'me matei de estudar', 'matei-me de rir', 'matar-me de tanto treinar',
      'me mato a limpar a casa', 'matei-me a cozinhar', 'mato-me de trabalho', 'me matei de estudo',
      'ele matou-se a correr', 'se mataram de rir', 'eles mataram-se de tanto trabalhar',
      'me matei no jogo', 'mato-me na partida', 'matou-se na final', 'se matou na quadra',
      'matar-me-ei a estudar', 'hei de me matar de tanto estudar',
      'isso me mata de rir', 'a saudade mata-me'
    ]) assert.equal(classifyNote(note), null, note);
  });

  test('exceção não cola depois da pontuação nem com outra palavra (casos negados)', () => {
    for (const note of [
      'mato-me. a trabalhar amanha', 'me matei, de rir nada', 'matei-me de verdade',
      'mato-me a serio', 'me matei hoje a noite'
    ]) assert.equal(classifyNote(note), 'alto', note);
  });

  test('guarda do substantivo «mato» (floresta)', () => {
    for (const note of [
      'perdi-me no mato me escondi', 'saiu do mato me chamando', 'passei pelo mato me arranhei',
      'fui ao mato me esconder', 'era um mato me disseram', 'cortei o mato me cansei'
    ]) assert.equal(classifyNote(note), null, note);
  });

  test('guarda do «mato» só vale colada e não atravessa pontuação (casos negados)', () => {
    for (const note of ['eu mato-me', 'no fim mato-me', 'fiquei no mato. me mato', 'o mato, me mato']) {
      assert.equal(classifyNote(note), 'alto', note);
    }
  });

  test('suicidar sem exceção de «a/de + verbo» (nada na proposta pede isso)', () => {
    for (const note of ['vou me suicidar de tanto trabalhar', 'suicidar-me de rir', 'me suicidei no jogo']) {
      assert.equal(classifyNote(note), 'alto', note);
    }
  });
});

describe('filtro de crise v2.2: «e eu junto» (2.1) e «ter morrido» (2.2)', () => {
  test('casos 4.1 da proposta disparam ALTO', () => {
    for (const note of [
      'meu pai morreu e eu junto', 'meu pai vai morrer e eu junto',
      'ela morreu na semana passada e eu junto', 'morreram e eu vou junto',
      'se ele morrer eu morro tambem', 'morreu. E eu junto.', 'o celular morreu e eu junto',
      'queria ter morrido'
    ]) assert.equal(classifyNote(note), 'alto', note);
  });

  test('casos 4.2 da proposta disparam MÉDIO', () => {
    for (const note of ['meu amigo morreu e eu tambem', 'ele morreu e vou atras dele',
      'ela morreu, devia ter sido eu']) {
      assert.equal(classifyNote(note), 'medio', note);
    }
  });

  test('cada palavra de morte com cada expressão ALTO', () => {
    const deaths = ['morreu', 'morreram', 'morrer', 'morra', 'morrerem', 'faleceu', 'falecer'];
    const expressions = ['e eu junto', 'eu junto', 'eu vou junto', 'vou junto', 'eu morro junto',
      'eu morro tambem', 'morro com ele', 'morro com ela', 'levem-me junto', 'leva-me junto', 'quero ir junto'];
    for (const death of deaths) {
      for (const expr of expressions) {
        assert.equal(classifyNote(`se ela ${death} ${expr}`), 'alto', `${death} ${expr}`);
        assert.equal(classifyNote(`${death} um dia desses ${expr}`), 'alto', `4 palavras: ${death} ${expr}`);
      }
    }
  });

  test('cada expressão MÉDIO', () => {
    for (const expr of ['e eu tambem', 'vou atras dele', 'vou atras dela', 'vou atras deles',
      'devia ter sido eu', 'deveria ter sido eu', 'queria ter ido com ele', 'queria ter ido com ela']) {
      assert.equal(classifyNote(`ele faleceu ontem ${expr}`), 'medio', expr);
    }
    // Duas ideias MÉDIO diferentes valem ALTO.
    assert.equal(classifyNote('ele morreu e vou atras dele. Nao vejo saida'), 'alto');
  });

  test('expressões de «junto» sem palavra de morte não disparam (casos negados)', () => {
    for (const note of ['me leva junto no passeio', 'eu vou junto ao cinema', 'e eu junto as fotos',
      'eu morro tambem de saudade', 'e eu tambem', 'vou atras dele no parque', 'devia ter sido eu a ir',
      'leva-me junto', 'quero ir junto']) {
      assert.equal(classifyNote(note), null, note);
    }
  });

  test('guardas e limites da regra do «junto» (casos 4.3 e negados)', () => {
    for (const note of [
      'meu avo morreu e eu tambem estou triste', 'morreu e eu junto com a familia organizei tudo',
      'ele morreu e vou junto com o primo ao funeral', 'ele morreu e vou atras dos documentos',
      'morreu e eu vou junto a missa', 'faleceu e eu junto da familia rezei', 'morreu e eu junto no carro fomos',
      'ela morreu e eu morro tambem de saudade', 'meu pai morreu', 'o cao morreu',
      'o celular vai morrer', 'a bateria do celular morreu',
      'morreu ha muitos anos atras ja e eu junto',
      'ele morreu e vou atras', 'ele morreu e eu tambem chorei'
    ]) assert.equal(classifyNote(note), null, note);
  });

  test('«morar» não é «morrer» (normalização junta os dois erres)', () => {
    for (const note of ['ele mora em lisboa e eu vou junto', 'meu avo faleceu e eu moro com ela',
      'a avo morreu, eu moro tambem ali', 'ela mora perto e eu junto as compras']) {
      assert.equal(classifyNote(note), null, note);
    }
    assert.equal(classifyNote('que ele morra e eu junto'), 'alto');
    assert.equal(classifyNote('ele morreu e eu morro com ele'), 'alto');
  });

  test('pontuação: 1.ª leitura não atravessa, 2.ª atravessa só para a frase de risco', () => {
    assert.equal(classifyNote('morreu. E eu junto.'), 'alto');
    assert.equal(classifyNote('morreu, e eu junto. com ela'), 'alto');
    assert.equal(classifyNote('meu amigo morreu e eu tambem. Hoje nao treinei'), 'medio');
  });

  test('«ter morrido» com gatilhos de querer, preferir, dever e «ia»', () => {
    for (const trigger of ['quero', 'queria', 'so queria', 'quer', 'prefiro', 'preferia', 'melhor',
      'seria melhor', 'devia', 'devo', 'talvez devesse', 'ia']) {
      assert.equal(classifyNote(`${trigger} ter morrido`), 'alto', trigger);
      assert.equal(classifyNote(`${trigger} mesmo ter morrido naquele dia`), 'alto', `${trigger} mesmo`);
    }
  });

  test('«ter morrido» sem gatilho ou com exceção não dispara (casos negados)', () => {
    for (const note of ['queria ter morrido de vergonha', 'devia ter morrido de rir', 'preferia ter morrido de sono',
      'ele pode ter morrido', 'o peixe deve ter morrido', 'achei que ia ver morrido',
      'vou ter morrido']) {
      assert.equal(classifyNote(note), null, note);
    }
    assert.equal(classifyNote('queria ter morrido. de vergonha nada'), 'alto');
  });
});

// Regressão fixa (revisão do PR 23): frases COM gatilho que davam ALTO na v2.1
// e têm de continuar ALTO. As exceções novas da v2.2 são só das formas sem gatilho.
const V21_HIGH_WITH_TRIGGER = [
  'vou me matar a trabalhar', 'quero matar-me a correr', 'quero me matar a limpar', 'vou me matar a rir',
  'quero me matar na quadra', 'vou me matar na final',
  'vou matar-me a cozinhar', 'quero me matar de limpar',
  'ideias de me matar na final', 'quero me matar a serio', 'vou mematar a trabalhar',
  'vou me matar hoje', 'penso em me matar a noite',
  'quero me suicidar de tanto trabalhar', 'ele quer se matar a correr', 'vou-me matar no treino',
  'quero morrer a sério', 'tenho vontade de me matar na quadra'
];

describe('filtro de crise v2.2: regressão da v2.1 (frases com gatilho)', () => {
  test('frases com gatilho que eram ALTO continuam ALTO', () => {
    for (const note of V21_HIGH_WITH_TRIGGER) assert.equal(classifyNote(note), 'alto', note);
  });

  test('gatilho novo da v2.2 também não ganha as exceções novas', () => {
    assert.equal(classifyNote('devia matar-me a estudar'), 'alto');
    assert.equal(classifyNote('mais vale me matar na final'), 'alto');
  });

  test('a lista de regressão era mesmo ALTO na v2.1 (referência congelada)', () => {
    const reference = require('../referencia/crisis-filter-tabela-v2.1.js');
    for (const note of V21_HIGH_WITH_TRIGGER) assert.equal(reference.classifyNote(note), 'alto', note);
  });
});

// Comportamento travado pela pesquisadora (respostas ao PR 23). Os casos «v2.3»
// seguem a decisão de 23/11; as duas exceções esperam o profissional.
describe('filtro de crise v2.2: desvios e casos travados', () => {
  test('desvio 1: «mora» (morar) não é «morra»', () => {
    assert.equal(classifyNote('mora longe e eu junto'), null);
  });
  test('desvio 2: «hoje» com o infinitivo nu', () => {
    assert.equal(classifyNote('me matar hoje'), 'alto');
  });
  test('desvio 3: «suicidar» sem exceção «a/de + verbo»', () => {
    assert.equal(classifyNote('me suicidar de tanto trabalhar'), 'alto');
  });
  test('desvio 4: «ter morrido de saudade» não é exceção', () => {
    assert.equal(classifyNote('queria ter morrido de saudade'), 'alto');
  });
  test('v2.3 (a): «me matei no treino» cala (exceção aprovada pelo profissional, 28/11); presente continua ALTO', () => {
    assert.equal(classifyNote('me matei no treino'), null);
    assert.equal(classifyNote('mato-me na academia'), 'alto');
    assert.equal(classifyNote('vou me matar no treino'), 'alto');
  });
  test('v2.3 (b): «devia morrer» sozinho agora dispara ALTO (decisão de 23/11)', () => {
    assert.equal(classifyNote('devia morrer'), 'alto');
  });
  test('v2.3 (c): «morreu de rir e eu junto» cala (exceção aprovada, 28/11); «morreu e eu junto» continua ALTO', () => {
    assert.equal(classifyNote('ele morreu de rir e eu junto'), null);
    assert.equal(classifyNote('ele morreu e eu junto'), 'alto');
    assert.equal(classifyNote('ele morreu de cancer e eu junto'), 'alto');
  });
});
