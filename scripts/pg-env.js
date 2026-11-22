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

// Ambiente e endereço para pg_dump / pg_restore, com as mesmas regras de
// TLS do servidor (lib/db-config.js): banco fora desta máquina só com TLS.
// A senha sai do endereço e vai em PGPASSWORD, para não aparecer na lista
// de processos. Devolve { url, env, cleanup }.
function pgClientSetup(url) {
  const fs = require('fs');
  const os = require('os');
  const { buildPoolConfig } = require('../lib/db-config');

  let built;
  try {
    built = buildPoolConfig({ ...process.env, DATABASE_URL: url });
  } catch (error) {
    if (error && error.name === 'DbConfigError') {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const env = { ...process.env, PGSSLMODE: built.mode };
  delete env.PGSSLROOTCERT;
  let tempDir = null;

  const ca = process.env.DATABASE_SSL_CA && String(process.env.DATABASE_SSL_CA).trim();
  const rootCertInUrl = new URLSearchParams(url.split('?')[1] || '').get('sslrootcert');
  if (built.mode === 'verify-full' || built.mode === 'verify-ca') {
    if (ca) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ca-'));
      const caPath = path.join(tempDir, 'ca.pem');
      fs.writeFileSync(caPath, String(ca).replace(/\\n/g, '\n'), { mode: 0o600 });
      env.PGSSLROOTCERT = caPath;
    } else if (rootCertInUrl) {
      env.PGSSLROOTCERT = rootCertInUrl;
    } else {
      // Certificados do sistema (precisa do cliente do Postgres 16 ou mais novo).
      env.PGSSLROOTCERT = 'system';
    }
  }

  let clientUrl = built.config.connectionString;
  try {
    const parsed = new URL(clientUrl);
    if (parsed.password) {
      env.PGPASSWORD = decodeURIComponent(parsed.password);
      parsed.password = '';
      clientUrl = parsed.toString();
    }
  } catch (error) {
    // Endereço que o URL do Node não lê (ex.: só socket): segue como veio.
  }

  function cleanup() {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { url: clientUrl, env, cleanup };
}

module.exports = { databaseUrl, databaseName, pgClientSetup };
