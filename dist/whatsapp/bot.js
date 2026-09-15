"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWhatsAppBot = startWhatsAppBot;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const orquestrador_js_1 = require("../ia/orquestrador.js");
const geolocalizacao_js_1 = require("../servicos/geolocalizacao.js");
const index_js_1 = require("../index.js");
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), ".env") });
// ============================================================
// SESSÕES EM MEMÓRIA
// ============================================================
const sessions = new Map();
const AUTH_DIR = "auth_info_baileys";
// ============================================================
// RESTAURAÇÃO DE CREDENCIAIS (para Render)
// ============================================================
function restaurarSessaoSeNecessario() {
    const credsBase64 = process.env.WHATSAPP_CREDS;
    if (!credsBase64)
        return;
    if (!fs_1.default.existsSync(AUTH_DIR)) {
        fs_1.default.mkdirSync(AUTH_DIR, { recursive: true });
    }
    const credsPath = path_1.default.join(AUTH_DIR, "creds.json");
    if (!fs_1.default.existsSync(credsPath)) {
        const credsJson = Buffer.from(credsBase64, "base64").toString("utf-8");
        fs_1.default.writeFileSync(credsPath, credsJson);
        console.log("🔑 Credenciais restauradas a partir da variável de ambiente!");
    }
}
// ============================================================
// MENSAGEM DE BOAS-VINDAS
// ============================================================
const MENSAGEM_BOAS_VINDAS = "Olá! Sou o assistente virtual do *Direciona SUS* 🏥\n\n" +
    "Meu papel é orientar qual serviço do SUS você deve procurar (UBS, UPA, Pronto-Socorro ou SAMU 192).\n\n" +
    "Por favor, me conte em detalhes: *o que está acontecendo ou o que você está sentindo?*\n" +
    '_(Se quiser, você também pode tirar dúvidas como: "qual a diferença entre UBS e UPA?")_';
// ============================================================
// COMANDOS DE RESET
// ============================================================
const comandosReset = [
    "/reset", "reset", "reiniciar",
    "comecar de novo", "começar de novo", "comecar dnv",
    "vamos comecar dnv", "vamos começar de novo",
    "voltar pro inicio", "voltar para o inicio", "voltar ao inicio",
    "inicio", "início", "menu", "cancelar",
];
// ============================================================
// FUNÇÃO PRINCIPAL DO BOT
// ============================================================
async function startWhatsAppBot() {
    restaurarSessaoSeNecessario();
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(AUTH_DIR);
    const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
    const sock = (0, baileys_1.default)({
        version,
        auth: {
            creds: state.creds,
            keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, (0, pino_1.default)({ level: "silent" })),
        },
        logger: (0, pino_1.default)({ level: "silent" }),
        browser: ["Direciona SUS", "Chrome", "1.0.0"],
    });
    sock.ev.on("creds.update", saveCreds);
    // ============================================================
    // CONEXÃO
    // ============================================================
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            (0, index_js_1.setQrCode)(qr);
            console.log("\n📲 *NOVO QR CODE GERADO!*");
            console.log("👉 Abra no navegador: https://SEU-BACKEND.onrender.com/qr");
            console.log("⏳ Escaneie em até 20 segundos!\n");
        }
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== baileys_1.DisconnectReason.loggedOut &&
                statusCode !== 401 &&
                statusCode !== 403) {
                console.log("🔄 Reconectando...");
                startWhatsAppBot();
            }
            else {
                console.log("❌ Desconectado permanentemente. Delete a pasta 'auth_info_baileys' e reinicie.");
            }
        }
        if (connection === "open") {
            (0, index_js_1.setQrCode)(null);
            console.log("✅ Bot do WhatsApp conectado com sucesso!");
        }
    });
    // ============================================================
    // EVENTO DE MENSAGENS
    // ============================================================
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify")
            return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe)
            return;
        const sender = msg.key.remoteJid;
        if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast")
            return;
        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";
        const cleanText = text.trim();
        // ---- CAPTURA DE LOCALIZAÇÃO ----
        const location = msg.message.locationMessage;
        if (location) {
            const lat = location.degreesLatitude;
            const lng = location.degreesLongitude;
            if (lat == null || lng == null) {
                await sock.sendMessage(sender, {
                    text: "📍 Localização inválida. Tente compartilhar novamente.",
                });
                return;
            }
            const estadoAtual = sessions.get(sender);
            if (estadoAtual?.aguardandoLocalizacao?.ativo) {
                const tipo = estadoAtual.aguardandoLocalizacao.tipo;
                try {
                    const unidades = await (0, geolocalizacao_js_1.buscarUnidadesProximas)(lat, lng, tipo);
                    let resposta = "";
                    if (unidades.length === 0) {
                        resposta =
                            `📍 Não encontrei unidades públicas próximas.\n\n` +
                                `Busque no Google Maps:\n` +
                                `https://www.google.com/maps/search/${tipo}/@${lat},${lng},15z`;
                    }
                    else {
                        resposta = `📍 *Unidades (${tipo}) mais próximas:*\n\n`;
                        unidades.forEach((u, i) => {
                            resposta +=
                                `${i + 1}. 🏥 *${u.nome}*\n` +
                                    `   📌 ${u.endereco}\n` +
                                    `   📏 ${(u.distancia / 1000).toFixed(1)} km\n` +
                                    `   🔗 ${u.linkGoogleMaps}\n\n`;
                        });
                        resposta += `_⚠️ Ligue antes para confirmar atendimento._`;
                    }
                    estadoAtual.aguardandoLocalizacao = undefined;
                    sessions.set(sender, estadoAtual);
                    await sock.sendMessage(sender, { text: resposta });
                }
                catch (err) {
                    console.error("❌ Erro ao buscar unidades:", err);
                    await sock.sendMessage(sender, {
                        text: "❌ Erro ao buscar unidades próximas.",
                    });
                }
                return;
            }
            else {
                await sock.sendMessage(sender, {
                    text: `📍 Localização recebida!\n\n` +
                        `Diga "Quero a UPA mais próxima" para eu buscar.`,
                });
                return;
            }
        }
        if (!cleanText)
            return;
        console.log(`\n📩 [${sender}] ${cleanText}`);
        // ---- RESET ----
        const textoLimpo = cleanText
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
        if (comandosReset.some((cmd) => {
            const cmdLimpo = cmd.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            return textoLimpo === cmdLimpo;
        })) {
            sessions.delete(sender);
            await sock.sendMessage(sender, {
                text: `🔄 Reiniciado.\n\n${MENSAGEM_BOAS_VINDAS}`,
            });
            return;
        }
        // ---- RESPONDE SIM/NÃO PARA LOCALIZAÇÃO ----
        const estadoAtual = sessions.get(sender);
        if (estadoAtual?.aguardandoLocalizacao?.ativo) {
            const sim = ["sim", "quero", "ok", "pode ser", "por favor", "manda"];
            const nao = ["não", "nao", "dispensa", "depois", "agora não"];
            if (sim.some((s) => textoLimpo.includes(s))) {
                await sock.sendMessage(sender, {
                    text: `📍 Compartilhe sua localização (📎 → Localização) para eu buscar a unidade.`,
                });
                return;
            }
            else if (nao.some((s) => textoLimpo.includes(s))) {
                estadoAtual.aguardandoLocalizacao = undefined;
                sessions.set(sender, estadoAtual);
                await sock.sendMessage(sender, {
                    text: "Tudo bem! Posso ajudar com mais algo?",
                });
                return;
            }
        }
        // ---- PROCESSA TURNO ----
        try {
            await sock.sendPresenceUpdate("composing", sender);
            if (!sessions.has(sender)) {
                const novoEstado = JSON.parse(JSON.stringify(orquestrador_js_1.ESTADO_INICIAL));
                sessions.set(sender, novoEstado);
                await sock.sendMessage(sender, { text: MENSAGEM_BOAS_VINDAS });
                return;
            }
            const estadoAtualProcesso = sessions.get(sender);
            const { resultado, estado: novoEstado } = await (0, orquestrador_js_1.processarTurno)(cleanText, estadoAtualProcesso);
            sessions.set(sender, novoEstado);
            let mensagemFinal = resultado.texto;
            if (resultado.tipo === "orientacao") {
                const respostaId = resultado.decisao?.resposta_id;
                let tipoLocalizacao = null;
                if (respostaId === "upa_001")
                    tipoLocalizacao = "UPA";
                else if (["emergencia_001", "obstetricia_001", "pediatria_emergencia_001", "mental_emergencia_001"].includes(respostaId))
                    tipoLocalizacao = "HOSPITAL";
                else if (respostaId === "ubs_001")
                    tipoLocalizacao = "UBS";
                if (tipoLocalizacao) {
                    const nome = tipoLocalizacao === "UPA" ? "UPA" : tipoLocalizacao === "HOSPITAL" ? "hospital" : "UBS";
                    mensagemFinal +=
                        `\n\n📍 *Quer saber a ${nome} mais próxima?* 🙋\n` +
                            `Responda *"sim"* e depois compartilhe sua localização.`;
                    const estadoApos = sessions.get(sender);
                    estadoApos.aguardandoLocalizacao = {
                        ativo: true,
                        tipo: tipoLocalizacao,
                        mensagemOriginal: mensagemFinal,
                    };
                    sessions.set(sender, estadoApos);
                }
            }
            await sock.sendMessage(sender, { text: mensagemFinal });
        }
        catch (error) {
            console.error("❌ Erro no processamento:", error);
            await sock.sendMessage(sender, {
                text: "❌ Ocorreu um erro. Tente novamente ou digite /reset.",
            });
        }
        finally {
            await sock.sendPresenceUpdate("paused", sender);
        }
    });
}
// ============================================================
// INICIALIZAÇÃO
// ============================================================
startWhatsAppBot().catch(console.error);
