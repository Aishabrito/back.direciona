"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setQrCode = setQrCode;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const qrcode_1 = __importDefault(require("qrcode"));
const rotas_js_1 = require("./api/rotas.js");
const bot_js_1 = require("./whatsapp/bot.js");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// ============================================================
// QR CODE — variável em memória que o bot atualiza
// ============================================================
let qrCodeString = null;
function setQrCode(qr) {
    qrCodeString = qr;
}
// Rota que retorna a imagem do QR Code (abra no navegador)
app.get('/qr', async (_req, res) => {
    if (!qrCodeString) {
        return res
            .status(404)
            .send('Nenhum QR Code disponível no momento.\n\n' +
            'Aguarde alguns segundos e recarregue esta página.\n' +
            'Se já conectou, este endpoint não é mais necessário.');
    }
    try {
        const png = await qrcode_1.default.toBuffer(qrCodeString, {
            width: 500,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' },
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.send(png);
    }
    catch (err) {
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
app.use('/api', rotas_js_1.rotasApi);
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`🚀 API do Direciona SUS rodando na porta ${PORTA}`);
    console.log(`📡 Health check: http://localhost:${PORTA}/health`);
    console.log(`📲 QR Code: http://localhost:${PORTA}/qr`);
});
// ============================================================
// Inicia o bot do WhatsApp
// ============================================================
(0, bot_js_1.startWhatsAppBot)().catch((err) => {
    console.error('❌ Erro ao iniciar o WhatsApp:', err);
});
