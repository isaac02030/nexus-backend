// ============================================
// NEXUS — Cifra dos arquivos de backup
//
// Só usa o módulo crypto do próprio Node (nenhum pacote novo).
// Chave: scrypt(frase, sal aleatório). Cifra: AES-256-GCM, que também
// detecta arquivo trocado ou frase errada.
//
// Formato do arquivo .dump.enc:
//   "NEXUSBK1" (8 bytes) | log2 do custo N do scrypt (1 byte) |
//   sal (16) | iv (12) | dados cifrados | etiqueta GCM (16)
// ============================================

const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('NEXUSBK1', 'ascii');
const LOG_N = 17; // N = 131072: ~0,3 s por chave, 128 MB de memória
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;
const MIN_PASSPHRASE_LENGTH = 16;

class BackupCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupCryptoError(
      `BACKUP_PASSPHRASE precisa ter pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres.`
    );
  }
}

function deriveKey(passphrase, salt, logN) {
  if (!Number.isInteger(logN) || logN < 14 || logN > 20) {
    throw new BackupCryptoError('O arquivo não parece um backup cifrado do Nexus.');
  }
  const N = 2 ** logN;
  return crypto.scryptSync(passphrase, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
}

async function encryptFile(inPath, outPath, passphrase, { logN = LOG_N } = {}) {
  checkPassphrase(passphrase);
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt, logN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const out = fs.createWriteStream(outPath, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, Buffer.from([logN]), salt, iv]));
  await pipeline(fs.createReadStream(inPath), cipher, out, { end: false });
  await new Promise((resolve, reject) => {
    out.end(cipher.getAuthTag(), err => (err ? reject(err) : resolve()));
  });
}

function readHeaderAndTag(inPath) {
  const size = fs.statSync(inPath).size;
  if (size < HEADER_BYTES + TAG_BYTES) {
    throw new BackupCryptoError('O arquivo é pequeno demais para ser um backup cifrado do Nexus.');
  }
  const fd = fs.openSync(inPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, header, 0, HEADER_BYTES, 0);
    const tag = Buffer.alloc(TAG_BYTES);
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupCryptoError('O arquivo não parece um backup cifrado do Nexus.');
    }
    let at = MAGIC.length;
    const logN = header[at]; at += 1;
    const salt = header.subarray(at, at + SALT_BYTES); at += SALT_BYTES;
    const iv = header.subarray(at, at + IV_BYTES);
    return { size, logN, salt, iv, tag };
  } finally {
    fs.closeSync(fd);
  }
}

// Decifra para outPath. Se a frase estiver errada ou o arquivo tiver sido
// mexido, apaga o que saiu e lança erro: nada meio decifrado fica para trás.
async function decryptFile(inPath, outPath, passphrase) {
  checkPassphrase(passphrase);
  const { size, logN, salt, iv, tag } = readHeaderAndTag(inPath);
  const key = deriveKey(passphrase, salt, logN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const body = size - TAG_BYTES > HEADER_BYTES
    ? fs.createReadStream(inPath, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 })
    : Readable.from([]);

  try {
    await pipeline(
      body,
      decipher,
      fs.createWriteStream(outPath, { mode: 0o600 })
    );
  } catch (err) {
    fs.rmSync(outPath, { force: true });
    if (err instanceof BackupCryptoError) throw err;
    if (err && /auth|unable to authenticate/i.test(String(err.message))) {
      throw new BackupCryptoError('Não consegui abrir o backup: a frase está errada ou o arquivo foi alterado.');
    }
    throw err;
  }
}

module.exports = {
  encryptFile,
  decryptFile,
  BackupCryptoError,
  MIN_PASSPHRASE_LENGTH
};
