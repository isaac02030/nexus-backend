// Origens aceitas pelo CORS.
// http://localhost:8080 so entra fora de producao, para o frontend local.
// A lista que ja existia continua igual em todos os ambientes.

const BASE_ORIGINS = [
  'https://isaac02030.github.io',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5173',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

const DEVELOPMENT_ORIGINS = [
  'http://localhost:8080'
];

function buildAllowedOrigins(nodeEnv = process.env.NODE_ENV) {
  const origins = new Set(BASE_ORIGINS);
  if (nodeEnv !== 'production') {
    for (const origin of DEVELOPMENT_ORIGINS) origins.add(origin);
  }
  return origins;
}

module.exports = { buildAllowedOrigins, BASE_ORIGINS, DEVELOPMENT_ORIGINS };
