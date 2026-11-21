const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { databaseUrl, databaseName, pgClientSetup } = require('./pg-env');
const { decryptFile, BackupCryptoError } = require('./backup-crypto');

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg || process.argv.length > 3 || fileArg.startsWith('-')) {
    console.error('Uso: npm run db:restore -- backups/nome-do-arquivo.dump (ou .dump.enc)');
    process.exit(1);
  }

  const dumpPath = path.resolve(fileArg);
  if (!fs.existsSync(dumpPath) || !fs.statSync(dumpPath).isFile()) {
    console.error(`Não encontrei o arquivo de backup: ${fileArg}`);
    process.exit(1);
  }

  const encrypted = dumpPath.endsWith('.enc');
  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  if (encrypted && !passphrase) {
    console.error('Este backup está cifrado. Defina BACKUP_PASSPHRASE com a frase usada no backup.');
    process.exit(1);
  }

  const url = databaseUrl();
  const name = databaseName(url);
  const target = name ? `banco ${name}` : 'banco indicado por DATABASE_URL';

  // Backup cifrado: decifra inteiro numa pasta temporária só sua, confere a
  // etiqueta e só então restaura. Assim, arquivo mexido não entra no banco.
  let tempDir = null;
  let restorePath = dumpPath;
  if (encrypted) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-'));
    restorePath = path.join(tempDir, 'backup.dump');
    try {
      await decryptFile(dumpPath, restorePath, passphrase);
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.error(error instanceof BackupCryptoError ? error.message : 'Não consegui decifrar o backup.');
      process.exit(1);
    }
  }

  console.log(`Restaurando ${path.basename(dumpPath)} para o ${target}.`);
  console.log('As tabelas desse banco passam a ficar iguais às do backup.');

  const client = pgClientSetup(url);
  let result;
  try {
    result = spawnSync('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      `--dbname=${client.url}`,
      restorePath
    ], { stdio: ['ignore', 'inherit', 'inherit'], env: client.env });
  } finally {
    client.cleanup();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (result.error && result.error.code === 'ENOENT') {
    console.error('Não encontrei o comando pg_restore.');
    console.error('Instale o cliente do PostgreSQL e tente de novo.');
    process.exit(1);
  }

  if (result.error || result.status !== 0) {
    console.error('A restauração falhou. O banco precisa existir (pode estar vazio) e a DATABASE_URL precisa apontar para ele.');
    process.exit(result.status || 1);
  }

  console.log('Restauração concluída.');
  console.log('Depois de restaurar, rode de novo scripts/sql/papel-do-app.sql para o usuário do app voltar a ter acesso às tabelas.');
}

main().catch(() => {
  console.error('A restauração falhou por um erro inesperado.');
  process.exit(1);
});
