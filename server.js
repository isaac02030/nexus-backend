// ============================================
// NEXUS — Servidor Principal
// Node.js + Express
// ============================================

const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARES
// São funções que correm em cada pedido
// antes de chegar à rota final
// ============================================
app.use(cors());               // Permite que o frontend aceda ao backend
app.use(express.json());       // Traduz JSON dos pedidos automaticamente

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
// POST /api/messages            → enviar mensagem
// GET  /api/messages/:missionId → ver conversa

// ============================================
// TRATAMENTO DE ERROS
// Se algo correr mal, devolve uma mensagem clara
// ============================================
app.use((err, req, res, next) => {
  console.error('Erro:', err.message);
  res.status(500).json({ error: 'Algo correu mal no servidor.' });
});

// ============================================
// INICIAR O SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🔥 Nexus API a correr em http://localhost:${PORT}`);
});

module.exports = app;
