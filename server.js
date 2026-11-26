// ============================================
// NEXUS — Servidor Principal
// Node.js + Express
// ============================================

const express = require('express');
const cors    = require('cors');
const { buildAllowedOrigins } = require('./lib/allowed-origins');
const { errorHandler } = require('./lib/error-handler');
const { checkStartupConfig } = require('./lib/startup-config');
require('dotenv').config();

// Antes de carregar as rotas (que abrem o Pool do banco): em produção, sem
// segredos fortes e distintos ou sem TLS no banco, o servidor não sobe.
if (require.main === module) {
  const { errors, warnings } = checkStartupConfig(process.env);
  for (const warning of warnings) console.warn(`Aviso: ${warning}`);
  if (errors.length) {
    console.error('O servidor não vai subir. Corrija nas variáveis de ambiente:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
}

const app  = express();
const PORT = process.env.PORT || 3000;
// Fora de producao entra http://localhost:8080. Com NODE_ENV=production, nao.
const ALLOWED_ORIGINS = buildAllowedOrigins(process.env.NODE_ENV);

// ============================================
// MIDDLEWARES
// São funções que correm em cada pedido
// antes de chegar à rota final
// ============================================
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origem nao autorizada pelo CORS.'));
  },
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));       // Traduz JSON dos pedidos automaticamente

// ============================================
// ROTAS
// Cada rota é um "endereço" da API
// O frontend faz pedidos a estes endereços
// ============================================

// --- Verificar se o servidor está vivo ---
app.get('/', (req, res) => {
  res.json({ message: 'Nexus API está online 🔥', version: '1.0.0' });
});

// --- UTILIZADORES ---
const userRoutes    = require('./routes/users');
app.use('/api/users', userRoutes);
// POST /api/users/register  → criar conta
// POST /api/users/login     → entrar

// --- MISSÕES ---
const missionRoutes = require('./routes/missions');
app.use('/api/missions', missionRoutes);
// POST   /api/missions          → criar missão
// GET    /api/missions/:id      → ver missão
// GET    /api/missions/match    → encontrar match
// PATCH  /api/missions/:id      → atualizar estado

// --- CHECK-INS ---
const checkinRoutes = require('./routes/checkins');
app.use('/api/checkins', checkinRoutes);
// POST /api/checkins            → registar check-in do dia
// GET  /api/checkins/:missionId → ver todos os check-ins de uma missão

// --- MENSAGENS ---
const messageRoutes = require('./routes/messages');
app.use('/api/messages', messageRoutes);

// --- PORTA ABERTA ---
const portaRoutes = require('./routes/porta-aberta');
app.use('/api/porta-aberta', portaRoutes);

// --- COMUNIDADES ---
const communityRoutes = require('./routes/communities');
app.use('/api/communities', communityRoutes);

// --- NOTIFICAÇÕES ---
const { router: notifRoutes } = require('./routes/notifications');
app.use('/api/notifications', notifRoutes);

// --- VÉRTICE ---
const verticeRoutes = require('./routes/vertice');
app.use('/api/vertice', verticeRoutes);

// --- ASSISTENTE IA ---
const assistantRoutes = require('./routes/assistant');
app.use('/api/assistant', assistantRoutes);

// --- INSIGHTS ---
const insightsRoutes = require('./routes/insights');
app.use('/api/insights', insightsRoutes);

// --- MISSÕES DAS COMUNIDADES ---
const inviteRoutes = require('./routes/invites');
app.use('/api/invites', inviteRoutes);
// POST   /api/invites           → criar convite (Duo ou Rival) por link
// DELETE /api/invites/:id       → cancelar convite
// POST   /api/invites/preview   → ver o convite (token no corpo)
// POST   /api/invites/accept    → aceitar o convite (token no corpo)

const communityMissionRoutes = require('./routes/community-missions');
app.use('/api/community-missions', communityMissionRoutes);
// POST /api/messages            → enviar mensagem
// GET  /api/messages/:missionId → ver conversa

// ============================================
// TRATAMENTO DE ERROS
// Se algo correr mal, devolve uma mensagem clara
// ============================================
app.use(errorHandler);

// ============================================
// INICIAR O SERVIDOR
// ============================================
if (require.main === module) {
  const { closeDb } = require('./lib/db');
  const { stopReminderScheduler } = require('./routes/notifications');
  const { createShutdown } = require('./lib/shutdown');

  const server = app.listen(PORT, () => {
    console.log(`🔥 Nexus API a correr em http://localhost:${PORT}`);
  });

  const shutdown = createShutdown({ server, closeDb, stopTimers: stopReminderScheduler });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
