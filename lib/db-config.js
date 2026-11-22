// ============================================
// NEXUS — Configuração da conexão com o Postgres
//
// Função pura: recebe as variáveis de ambiente e devolve a configuração do
// Pool, ou lança um erro calmo dizendo o que corrigir. Nunca põe senha,
// endereço ou segredo na mensagem de erro.
//
// Regras:
// - TLS é o padrão (verify-full: cifra e confere o certificado e o nome).
// - DATABASE_SSL escolhe o modo: verify-full, verify-ca, require ou disable.
//   O sslmode da DATABASE_URL também vale; se os dois vierem diferentes,
//   o servidor recusa (melhor parar do que adivinhar).
// - disable (sem TLS) só fora de produção E com o banco nesta máquina.
// - Em produção, falta de DATABASE_URL ou TLS desligado: recusa.
// ============================================

const DEFAULT_POOL_MAX = 5;
const MAX_POOL_MAX = 20;
const IDLE_TIMEOUT_MS = 30000;
const CONNECTION_TIMEOUT_MS = 10000;

const SSL_MODES = new Set(['verify-full', 'verify-ca', 'require', 'disable']);
// Parâmetros de TLS da URL. Saem da URL antes de ir para o pg, para o modo
// escolhido aqui não ser trocado em silêncio pelo que vier na URL.
const URL_SSL_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

class DbConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbConfigError';
  }
}

function isProduction(env) {
  return env.NODE_ENV === 'production';
}

function splitUrl(url) {
  const q = url.indexOf('?');
  if (q === -1) return { base: url, params: new URLSearchParams('') };
  return { base: url.slice(0, q), params: new URLSearchParams(url.slice(q + 1)) };
}

// Modo pedido pela URL (sslmode ou ssl=...). null = a URL não diz nada.
function sslModeFromUrl(params) {
  if (params.has('sslmode')) {
    const mode = String(params.get('sslmode')).trim().toLowerCase();
    if (mode === 'allow' || mode === 'prefer') {
      throw new DbConfigError(
        `sslmode=${mode} na DATABASE_URL pode conectar sem TLS. Use sslmode=verify-full (ou require).`
      );
    }
    if (!SSL_MODES.has(mode)) {
      throw new DbConfigError('sslmode da DATABASE_URL não é válido. Use verify-full, verify-ca, require ou disable.');
    }
    return mode;
  }
  if (params.has('ssl')) {
    const ssl = String(params.get('ssl')).trim().toLowerCase();
    if (ssl === 'false' || ssl === '0') return 'disable';
    if (ssl === 'no-verify') return 'require';
    return null; // ssl=true: TLS ligado, fica o padrão (verify-full)
  }
  return null;
}

function sslModeFromEnv(env) {
  const raw = env.DATABASE_SSL;
  if (raw === undefined || String(raw).trim() === '') return null;
  const mode = String(raw).trim().toLowerCase();
  if (!SSL_MODES.has(mode)) {
    throw new DbConfigError('DATABASE_SSL não é válido. Use verify-full, verify-ca, require ou disable.');
  }
  return mode;
}

// Host de onde o banco está. Socket Unix (começa com /) conta como local.
// O parâmetro host= da URL, quando vem, vale mais que o host do endereço.
function hostIsLocal(base, params) {
  // host= vazio não vale: conta o host do endereço (ex.: evil.com/db?host=).
  let host = params.get('host');
  if (host === null || host.trim() === '') {
    try {
      host = decodeURIComponent(new URL(base).hostname);
    } catch (err) {
      return false;
    }
  }
  if (!host) return true; // sem host: o Postgres usa o socket local
  return String(host)
    .split(',')
    .every(h => h.trim().startsWith('/') || LOCAL_HOSTS.has(h.trim().toLowerCase()));
}

// O endereço aponta para um banco nesta máquina (localhost, 127.0.0.1, ::1
// ou socket)? Usado também pelos scripts de backup.
function isLocalDatabaseUrl(url) {
  const { base, params } = splitUrl(String(url || '').trim());
  return hostIsLocal(base, params);
}

function poolMaxFrom(env) {
  const raw = env.DATABASE_POOL_MAX;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_POOL_MAX;
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < 1 || n > MAX_POOL_MAX) {
    throw new DbConfigError(`DATABASE_POOL_MAX precisa ser um número inteiro de 1 a ${MAX_POOL_MAX}.`);
  }
  return n;
}

function sslOptionsFor(mode, env) {
  const ca = env.DATABASE_SSL_CA && String(env.DATABASE_SSL_CA).trim()
    ? String(env.DATABASE_SSL_CA).replace(/\\n/g, '\n')
    : null;

  if (mode === 'disable') return false;
  if (mode === 'require') {
    // Cifra, mas não confere o certificado: protege de quem só escuta,
    // não de quem se passa pelo banco. Prefira verify-full.
    return { rejectUnauthorized: false };
  }
  if (mode === 'verify-ca') {
    if (!ca) {
      throw new DbConfigError('DATABASE_SSL=verify-ca precisa do certificado do provedor em DATABASE_SSL_CA.');
    }
    return { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined };
  }
  // verify-full
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

function buildPoolConfig(env = process.env) {
  const production = isProduction(env);
  const rawUrl = env.DATABASE_URL ? String(env.DATABASE_URL).trim() : '';

  if (production && !rawUrl) {
    throw new DbConfigError('Falta DATABASE_URL. Em produção o servidor não sobe sem o endereço do banco.');
  }

  const max = poolMaxFrom(env);
  const warnings = [];

  const { base, params } = splitUrl(rawUrl);
  const fromUrl = rawUrl ? sslModeFromUrl(params) : null;
  const fromEnv = sslModeFromEnv(env);

  if (fromUrl && fromEnv && fromUrl !== fromEnv) {
    throw new DbConfigError(
      'DATABASE_SSL e o sslmode da DATABASE_URL pedem modos diferentes. Deixe só um, ou os dois iguais.'
    );
  }

  const mode = fromEnv || fromUrl || 'verify-full';

  if (mode === 'disable') {
    if (production) {
      throw new DbConfigError('TLS desligado em produção. O servidor só conecta ao banco com TLS (DATABASE_SSL=verify-full).');
    }
    if (rawUrl && !hostIsLocal(base, params)) {
      throw new DbConfigError('TLS só pode ser desligado com o banco nesta máquina (localhost). Para outro endereço, use TLS.');
    }
  }

  if (mode === 'require' && production) {
    warnings.push('Banco com TLS em modo require: a conexão é cifrada, mas o certificado não é conferido. Prefira verify-full.');
  }

  for (const key of URL_SSL_PARAMS) params.delete(key);
  const rest = params.toString();
  const connectionString = rawUrl ? (rest ? `${base}?${rest}` : base) : undefined;

  return {
    config: {
      connectionString,
      ssl: sslOptionsFor(mode, env),
      max,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS
    },
    mode,
    warnings
  };
}

module.exports = {
  buildPoolConfig,
  isLocalDatabaseUrl,
  DbConfigError,
  DEFAULT_POOL_MAX,
  MAX_POOL_MAX
};
