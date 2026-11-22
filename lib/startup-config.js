// ============================================
// NEXUS — Conferência antes de subir o servidor
//
// Em produção (NODE_ENV=production) o servidor não sobe se:
// - JWT_SECRET ou VERTICE_SECRET faltarem, forem curtos, fracos ou o
//   texto de exemplo do env.example;
// - os dois segredos forem iguais;
// - a conexão com o banco não tiver TLS (ver lib/db-config.js).
// Fora de produção, os problemas dos segredos viram avisos.
//
// As mensagens dizem o nome da variável e o que fazer. Nunca o valor.
// ============================================

const { buildPoolConfig } = require('./db-config');

const MIN_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARS = 10;
// Textos de exemplo que já apareceram no env.example. Não valem como segredo.
const PLACEHOLDER_SECRETS = new Set([
  'troque-por-um-segredo-longo-e-aleatorio',
  'troque-por-outro-segredo-longo-e-aleatorio'
]);
const HOW_TO_GENERATE = 'Gere um com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

function secretProblem(name, value) {
  if (value === undefined || value === null || String(value) === '') {
    return `Falta ${name}. ${HOW_TO_GENERATE}`;
  }
  const text = String(value);
  if (PLACEHOLDER_SECRETS.has(text.trim())) {
    return `${name} ainda é o texto de exemplo do env.example. Troque por um segredo novo. ${HOW_TO_GENERATE}`;
  }
  if (text.length < MIN_SECRET_LENGTH) {
    return `${name} é curto demais (mínimo ${MIN_SECRET_LENGTH} caracteres). ${HOW_TO_GENERATE}`;
  }
  if (new Set(text).size < MIN_DISTINCT_CHARS) {
    return `${name} repete poucos caracteres e é fácil de adivinhar. ${HOW_TO_GENERATE}`;
  }
  return null;
}

function checkSecrets(env = process.env) {
  const problems = [];
  const jwtProblem = secretProblem('JWT_SECRET', env.JWT_SECRET);
  const verticeProblem = secretProblem('VERTICE_SECRET', env.VERTICE_SECRET);
  if (jwtProblem) problems.push(jwtProblem);
  if (verticeProblem) problems.push(verticeProblem);
  if (env.JWT_SECRET && env.VERTICE_SECRET && String(env.JWT_SECRET) === String(env.VERTICE_SECRET)) {
    problems.push('JWT_SECRET e VERTICE_SECRET são iguais. Cada um precisa do seu próprio segredo.');
  }
  return problems;
}

function checkDatabase(env = process.env) {
  try {
    const { warnings } = buildPoolConfig(env);
    return { problems: [], warnings };
  } catch (err) {
    if (err && err.name === 'DbConfigError') return { problems: [err.message], warnings: [] };
    throw err;
  }
}

// errors: impedem subir. warnings: só avisam.
// Segredos: erro só em produção (fora dela, aviso). Banco mal configurado é
// erro sempre, porque o Pool não teria como conectar do jeito pedido.
function checkStartupConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const secretProblems = checkSecrets(env);
  const database = checkDatabase(env);

  if (production) {
    return { errors: [...secretProblems, ...database.problems], warnings: database.warnings };
  }
  return { errors: database.problems, warnings: [...secretProblems, ...database.warnings] };
}

module.exports = {
  checkStartupConfig,
  checkSecrets,
  MIN_SECRET_LENGTH
};
