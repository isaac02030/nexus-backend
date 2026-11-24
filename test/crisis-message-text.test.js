const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Frase dos avisos de crise (decisão de 24/11): a primeira frase de cada aviso
// fica igual; o fim passa a ser condicional («Se você está…»), porque o filtro
// erra nos dois sentidos e o app não sabe como a pessoa está.
const FIM = 'Se você está passando por um momento difícil, veja os contatos de ajuda abaixo.';
const ANTIGO = 'Parece que você está passando por um momento difícil';

const ESPERADOS = {
  'lib/adult-gate.js': [`Nada foi enviado. ${FIM}`],
  'routes/assistant.js': [`Sua pergunta não foi enviada ao assistente. ${FIM}`],
  'routes/communities.js': [
    `Seu post não foi publicado. ${FIM}`,
    `Sua denúncia foi registrada, sem o texto que você escreveu. ${FIM}`,
    `Sua denúncia não foi enviada. ${FIM}`
  ],
  'routes/messages.js': [
    `Sua mensagem não foi enviada. ${FIM}`,
    `Sua denúncia foi registrada, sem o texto que você escreveu. ${FIM}`,
    `Sua denúncia não foi enviada. ${FIM}`
  ]
};

const ler = (arquivo) => fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');

test('os 8 avisos de crise têm o texto exato aprovado', () => {
  let total = 0;
  for (const [arquivo, textos] of Object.entries(ESPERADOS)) {
    const fonte = ler(arquivo);
    for (const texto of textos) {
      assert.ok(fonte.includes(`'${texto}'`), `${arquivo}: falta «${texto}»`);
      total += 1;
    }
  }
  assert.equal(total, 8);
});

test('negado: «Parece que você está passando…» não volta em nenhuma rota nem lib', () => {
  for (const pasta of ['lib', 'routes']) {
    for (const nome of fs.readdirSync(path.join(__dirname, '..', pasta))) {
      if (!nome.endsWith('.js')) continue;
      assert.equal(ler(`${pasta}/${nome}`).includes(ANTIGO), false, `${pasta}/${nome} ainda tem a frase antiga`);
    }
  }
});
