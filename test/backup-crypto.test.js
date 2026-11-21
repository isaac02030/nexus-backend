const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encryptFile, decryptFile, BackupCryptoError } = require('../scripts/backup-crypto');

const PHRASE = 'frase-de-teste-que-nao-e-real';
let dir;
let plain;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cripto-teste-'));
  plain = path.join(dir, 'a.dump');
  fs.writeFileSync(plain, Buffer.concat([Buffer.from('email-falso@exemplo.invalid '), crypto.randomBytes(200000)]));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

// logN 14: mais rápido no teste; o arquivo guarda o custo usado.
const enc = (input, out, phrase = PHRASE) => encryptFile(input, out, phrase, { logN: 14 });

test('cifra e decifra igual; o texto aberto não aparece no arquivo cifrado', async () => {
  const out = path.join(dir, 'a.enc');
  const back = path.join(dir, 'a.back');
  await enc(plain, out);
  assert.ok(!fs.readFileSync(out).includes(Buffer.from('exemplo.invalid')));
  assert.equal(fs.statSync(out).mode & 0o077, 0, 'só o dono lê o arquivo');
  await decryptFile(out, back, PHRASE);
  assert.ok(fs.readFileSync(back).equals(fs.readFileSync(plain)));
});

test('negado: frase errada não deixa arquivo decifrado', async () => {
  const out = path.join(dir, 'b.enc');
  const back = path.join(dir, 'b.back');
  await enc(plain, out);
  await assert.rejects(decryptFile(out, back, 'outra-frase-que-nao-e-real'), err =>
    err instanceof BackupCryptoError && /frase está errada/.test(err.message));
  assert.equal(fs.existsSync(back), false);
});

test('negado: arquivo alterado (1 bit) é recusado', async () => {
  const out = path.join(dir, 'c.enc');
  const back = path.join(dir, 'c.back');
  await enc(plain, out);
  const buf = fs.readFileSync(out);
  buf[5000] ^= 1;
  fs.writeFileSync(out, buf);
  await assert.rejects(decryptFile(out, back, PHRASE), BackupCryptoError);
  assert.equal(fs.existsSync(back), false);
});

test('negado: frase curta e arquivo que não é backup do Nexus', async () => {
  await assert.rejects(enc(plain, path.join(dir, 'd.enc'), 'curta'), /pelo menos 16/);
  await assert.rejects(decryptFile(plain, path.join(dir, 'd.back'), PHRASE), /não parece um backup/);
});

test('arquivo vazio também volta vazio', async () => {
  const empty = path.join(dir, 'vazio.dump');
  fs.writeFileSync(empty, '');
  await enc(empty, path.join(dir, 'vazio.enc'));
  await decryptFile(path.join(dir, 'vazio.enc'), path.join(dir, 'vazio.back'), PHRASE);
  assert.equal(fs.statSync(path.join(dir, 'vazio.back')).size, 0);
});
