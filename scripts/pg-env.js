const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND') {
    console.error('Faltam as dependências do projeto. Na pasta do backend, rode: npm install');
    process.exit(1);
  }
  throw error;
}

function databaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw || !raw.trim()) {
    console.error('Falta a variável DATABASE_URL.');
    console.error('Copie env.example para .env e preencha o endereço do banco, ou defina DATABASE_URL no terminal.');
    process.exit(1);
  }

  const url = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(url) || /\s/.test(url)) {
    console.error('DATABASE_URL precisa ser um endereço de Postgres, começar com postgresql:// e não ter espaços.');
    process.exit(1);
  }

  return url;
}

function databaseName(url) {
  const pathPart = url.split('?')[0];
  const slash = pathPart.lastIndexOf('/');
  const scheme = pathPart.indexOf('://');
  if (slash === -1 || scheme === -1 || slash <= scheme + 2) {
    return '';
  }

  const name = pathPart.slice(slash + 1);
  if (!name) return '';

  try {
    return decodeURIComponent(name);
  } catch (error) {
    return name;
  }
}

module.exports = { databaseUrl, databaseName };
