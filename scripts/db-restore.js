const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { databaseUrl, databaseName } = require('./pg-env');

const fileArg = process.argv[2];
if (!fileArg || process.argv.length > 3 || fileArg.startsWith('-')) {
  console.error('Uso: npm run db:restore -- backups/nome-do-arquivo.dump');
  process.exit(1);
}

const dumpPath = path.resolve(fileArg);
if (!fs.existsSync(dumpPath) || !fs.statSync(dumpPath).isFile()) {
  console.error(`Não encontrei o arquivo de backup: ${fileArg}`);
  process.exit(1);
}

const url = databaseUrl();
const name = databaseName(url);
const target = name ? `banco ${name}` : 'banco indicado por DATABASE_URL';
console.log(`Restaurando ${path.basename(dumpPath)} para o ${target}.`);
console.log('As tabelas desse banco passam a ficar iguais às do backup.');

const result = spawnSync('pg_restore', [
  '--clean',
  '--if-exists',
  '--no-owner',
  '--no-acl',
  '--exit-on-error',
  `--dbname=${url}`,
  dumpPath
], { stdio: ['ignore', 'inherit', 'inherit'] });

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
