// src/index.ts
import express from 'express';
import cors from 'cors';
import { rotasApi } from './api/rotas';
import { startWhatsAppBot } from './whatsapp/bot';

const app = express();
app.use(cors());
app.use(express.json());

// Rota HTTP consumida pelo App (Web/Mobile)
app.use('/api', rotasApi);

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`🚀 API do Direciona SUS rodando na porta ${PORTA}`);
});

// Inicia o bot do WhatsApp em paralelo
startWhatsAppBot().catch((err: unknown) => {
  console.error('Erro ao iniciar o WhatsApp:', err);
});