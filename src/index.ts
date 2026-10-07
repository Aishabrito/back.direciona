// src/index.ts
// dotenv PRIMEIRO: os módulos abaixo leem process.env ao carregar.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { rotasApi } from './api/rotas.js';
import { startWhatsAppBot } from './whatsapp/bot.js';
import { getQrCode } from './servicos/qr.js';
import { getStatusWhatsApp } from './servicos/status_whatsapp.js';

// Não deixa o processo morrer por promise rejeitada ou exceção não capturada.
// Erros de sessão do Baileys (Bad MAC etc.) são ruído conhecido e não são logados.
const RUIDO_BAILEYS = /Bad MAC|Unsupported state|Connection Closed|Precondition Required/i;
process.on('unhandledRejection', (err: any) => {
  if (RUIDO_BAILEYS.test(err?.message || String(err))) return;
  console.error('❌ Unhandled rejection:', err);
});
process.on('uncaughtException', (err: any) => {
  if (RUIDO_BAILEYS.test(err?.message || String(err))) return;
  console.error('❌ Uncaught exception:', err);
});

const app = express();
app.use(cors());
// Áudio do app chega em base64 (até ~1 min de fala); o resto continua limitado a 100 KB.
app.use('/api/audio', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '100kb' }));

app.get('/qr', async (_req, res) => {
  const qrCodeString = getQrCode();
  if (!qrCodeString) {
    return res
      .status(404)
      .send(
        'Nenhum QR Code disponível no momento.\n\n' +
          'Aguarde alguns segundos e recarregue esta página.\n' +
          'Se já conectou, este endpoint não é mais necessário.',
      );
  }
  try {
    const png = await QRCode.toBuffer(qrCodeString, {
      width: 500,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    console.error('Erro ao gerar QR Code:', err);
    res.status(500).send('Erro ao gerar QR Code.');
  }
});

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// Estado da conexão com o WhatsApp (o /health continua 200 enquanto o processo estiver de pé).
app.get('/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ whatsapp: getStatusWhatsApp(), qrDisponivel: Boolean(getQrCode()) });
});

app.use('/api', rotasApi);

const PORTA = Number(process.env.PORT) || 3000;
app.listen(PORTA, '0.0.0.0', () => {
  console.log(`🚀 API do Direciona.Ai rodando na porta ${PORTA}`);
  console.log(`📡 Health check: http://localhost:${PORTA}/health`);
  console.log(`📲 QR Code: http://localhost:${PORTA}/qr`);
});

// ============================================================
// Inicia o bot do WhatsApp — UMA ÚNICA VEZ
// ============================================================
startWhatsAppBot().catch((err: unknown) => {
  console.error('❌ Erro ao iniciar o WhatsApp:', err);
});
