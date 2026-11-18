const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { databaseUrl, databaseName } = require('./pg-env');

const url = databaseUrl();
const backupDir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const fileName = `nexus-${stamp}.dump`;
const finalPath = path.join(backupDir, fileName);
const partialPath = path.join(backupDir, `.${fileName}.partial`);

const result = spawnSync('pg_dump', [
  '--format=custom',
  '--no-owner',
  '--no-acl',
  '--file', partialPath,
  url
], { stdio: ['ignore', 'inherit', 'inherit'] });

if (result.error && result.error.code === 'ENOENT') {
  console.error('Não encontrei o comando pg_dump.');
  console.error('Instale o cliente do PostgreSQL e tente de novo.');
  process.exit(1);
}

if (result.error || result.status !== 0) {
  fs.rmSync(partialPath, { force: true });
  console.error('O backup falhou. Confira se o Postgres está ligado e se DATABASE_URL está certa.');
  process.exit(result.status || 1);
}

fs.renameSync(partialPath, finalPath);

const name = databaseName(url);
const target = name ? `banco ${name}` : 'banco indicado por DATABASE_URL';
console.log(`Backup do ${target} salvo em backups/${fileName}`);
console.log('Esta pasta não vai para o GitHub. Não compartilhe este arquivo: pode ter dados de pessoas.');
