// ============================================
// NEXUS — Conexão única com o Postgres
//
// Um Pool só para o servidor inteiro. Todas as rotas usam este `db`.
// Antes cada rota abria o seu (cerca de 11 Pools de até 10 conexões cada),
// o que podia passar do limite de conexões de um plano pequeno.
//
// Tamanho: DATABASE_POOL_MAX (padrão 5). TLS e regras: lib/db-config.js.
// ============================================

const { Pool } = require('pg');
const { buildPoolConfig } = require('./db-config');

// Os avisos (ex.: TLS em modo require) saem uma vez, na subida (server.js).
const { config } = buildPoolConfig(process.env);

const db = new Pool(config);

// Uma conexão parada que cai (banco reiniciou, rede) emite 'error' no Pool.
// Sem este ouvinte o processo inteiro cairia. Loga só o código, sem dados.
db.on('error', err => {
  console.error('Uma conexão parada com o banco caiu; o Pool abre outra quando precisar.', err && err.code ? `(código ${err.code})` : '');
});

let closing = null;

// Fecha o Pool uma vez só (chamar de novo devolve a mesma promessa).
function closeDb() {
  if (!closing) closing = db.end();
  return closing;
}

module.exports = { db, closeDb };
