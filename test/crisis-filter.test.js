const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyNote, normalizeNote } = require('../lib/crisis-filter');

// Casos de teste da lista de palavras do conselho (secção 4).
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
