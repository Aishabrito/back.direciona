// src/index.ts
import express from 'express';
import cors from 'cors';
import { rotasApi } from './api/rotas.js';
import { iniciarBotWhatsApp } from './whatsapp/bot.js';

const app = express();
app.use(cors());
app.use(express.json());

// Rota para o Aplicativo (Web / Mobile)
app.use('/api', rotasApi);

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`🚀 API do Direciona SUS rodando na porta ${PORTA}`);
});

// Inicia o serviço do WhatsApp paralelamente
iniciarBotWhatsApp().catch((err) => {
  console.error('Erro ao iniciar o WhatsApp:', err);
});