"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const rotas_js_1 = require("./api/rotas.js");
const bot_js_1 = require("./whatsapp/bot.js");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// ============================================================
// HEALTH CHECK (UptimeRobot pinga aqui para não deixar dormir)
// ============================================================
app.get('/health', (_req, res) => {
    res.status(200).send('OK');
});
// ============================================================
// Rota HTTP consumida pelo App (Web/Mobile)
// ============================================================
app.use('/api', rotas_js_1.rotasApi);
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`🚀 API do Direciona SUS rodando na porta ${PORTA}`);
    console.log(`📡 Health check: http://localhost:${PORTA}/health`);
});
// ============================================================
// Inicia o bot do WhatsApp em paralelo
// ============================================================
(0, bot_js_1.startWhatsAppBot)().catch((err) => {
    console.error('❌ Erro ao iniciar o WhatsApp:', err);
});
