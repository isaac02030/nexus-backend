const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { databaseUrl, databaseName, pgClientSetup } = require('./pg-env');
const { encryptFile, BackupCryptoError } = require('./backup-crypto');

async function main() {
  const url = databaseUrl();
  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `nexus-${stamp}.dump`;
  const fileName = passphrase ? `${baseName}.enc` : baseName;
  const finalPath = path.join(backupDir, fileName);
  const partialPath = path.join(backupDir, `.${baseName}.partial`);
  const encPartialPath = path.join(backupDir, `.${baseName}.enc.partial`);

  const client = pgClientSetup(url);
  let result;
  try {
    result = spawnSync('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--file', partialPath,
      `--dbname=${client.url}`
    ], { stdio: ['ignore', 'inherit', 'inherit'], env: client.env });
  } finally {
    client.cleanup();
  }

  if (result.error && result.error.code === 'ENOENT') {
    console.error('Não encontrei o comando pg_dump.');
    console.error('Instale o cliente do PostgreSQL e tente de novo.');
    process.exit(1);
  }

  if (result.error || result.status !== 0) {
    fs.rmSync(partialPath, { force: true });
    console.error('O backup falhou. Confira se o Postgres está ligado, se DATABASE_URL está certa e se o TLS (DATABASE_SSL) combina com o banco.');
    process.exit(result.status || 1);
  }

  if (passphrase) {
    try {
      await encryptFile(partialPath, encPartialPath, passphrase);
      fs.renameSync(encPartialPath, finalPath);
    } catch (error) {
      // process.exit não passa pelo finally: apaga aqui os dois arquivos.
      fs.rmSync(encPartialPath, { force: true });
      fs.rmSync(partialPath, { force: true });
      if (error instanceof BackupCryptoError) {
        console.error(error.message);
      } else {
        console.error('Não consegui cifrar o backup.');
      }
      process.exit(1);
    } finally {
      // O arquivo aberto (sem cifra) nunca fica no disco.
      fs.rmSync(partialPath, { force: true });
    }
  } else {
    fs.renameSync(partialPath, finalPath);
  }

  const name = databaseName(url);
  const target = name ? `banco ${name}` : 'banco indicado por DATABASE_URL';
  console.log(`Backup do ${target} salvo em backups/${fileName}`);
  if (passphrase) {
    console.log('O arquivo está cifrado. Para restaurar, precisa da mesma BACKUP_PASSPHRASE.');
  } else {
    console.log('Atenção: este backup NÃO está cifrado. Não tire este arquivo deste computador.');
    console.log('Para sair cifrado, defina BACKUP_PASSPHRASE (ver docs/backup.md).');
  }
  console.log('Esta pasta não vai para o GitHub. Não compartilhe este arquivo: pode ter dados de pessoas.');
}

main().catch(() => {
  console.error('O backup falhou por um erro inesperado.');
  process.exit(1);
});
