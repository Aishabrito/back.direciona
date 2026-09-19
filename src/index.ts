// src/index.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { rotasApi } from './api/rotas.js';
import { startWhatsAppBot } from './whatsapp/bot.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// QR CODE — variável em memória que o bot atualiza
// ============================================================
let qrCodeString: string | null = null;

export function setQrCode(qr: string | null) {
  qrCodeString = qr;
}

// Rota que retorna a imagem do QR Code (abra no navegador)
app.get('/qr', async (_req, res) => {
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

// ============================================================
// HEALTH CHECK (UptimeRobot)
// ============================================================
app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// ============================================================
// API para o app móvel
// ============================================================
app.use('/api', rotasApi);

const PORTA = Number(process.env.PORT) || 3000;


app.listen(PORTA, '0.0.0.0', () => {
  console.log(`🚀 API do Direciona SUS rodando na porta ${PORTA}`);
  console.log(`📡 Health check: http://localhost:${PORTA}/health`);
  console.log(`📲 QR Code: http://localhost:${PORTA}/qr`);
});
// ============================================================
// Inicia o bot do WhatsApp
// ============================================================
startWhatsAppBot().catch((err: unknown) => {
  console.error('❌ Erro ao iniciar o WhatsApp:', err);
});