
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { rotasApi } from './api/rotas.js';
import { startWhatsAppBot } from './whatsapp/bot.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// HEALTH CHECK (UptimeRobot pinga aqui para não deixar dormir)
// ============================================================
app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// ============================================================
// Rota HTTP consumida pelo App (Web/Mobile)
// ============================================================
app.use('/api', rotasApi);

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`🚀 API do Direciona SUS rodando na porta ${PORTA}`);
  console.log(`📡 Health check: http://localhost:${PORTA}/health`);
});

// ============================================================
// Inicia o bot do WhatsApp em paralelo
// ============================================================
startWhatsAppBot().catch((err: unknown) => {
  console.error('❌ Erro ao iniciar o WhatsApp:', err);
});