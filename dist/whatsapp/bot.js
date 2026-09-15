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
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const pino_1 = __importDefault(require("pino"));
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), ".env") });
const orquestrador_js_1 = require("../ia/orquestrador.js");
const geolocalizacao_js_1 = require("../servicos/geolocalizacao.js");
// ============================================================
// SERVIDOR DE MONITORAMENTO (para Render)
// ============================================================
const PORT = process.env.PORT || 3000;
http_1.default
    .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot do WhatsApp rodando 24/7!");
})
    .listen(PORT, () => {
    console.log(`🌐 Servidor de monitoramento escutando na porta ${PORT}`);
});
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
// MENSAGEM DE BOAS‑VINDAS
// ============================================================
const MENSAGEM_BOAS_VINDAS = "Olá! Sou o assistente virtual do *Direciona SUS* 🏥\n\n" +
    "Meu papel é orientar qual serviço do SUS você deve procurar (UBS, UPA, Pronto-Socorro ou SAMU 192).\n\n" +
    "Por favor, me conte em detalhes: *o que está acontecendo ou o que você está sentindo?*\n" +
    '_(Se quiser, você também pode tirar dúvidas como: "qual a diferença entre UBS e UPA?")_';
// ============================================================
// COMANDOS DE RESET
// ============================================================
const comandosReset = [
    "/reset",
    "reset",
    "reiniciar",
    "comecar de novo",
    "começar de novo",
    "comecar dnv",
    "vamos comecar dnv",
    "vamos começar de novo",
    "voltar pro inicio",
    "voltar para o inicio",
    "voltar ao inicio",
    "inicio",
    "início",
    "menu",
    "cancelar",
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
        printQRInTerminal: true,
        logger: (0, pino_1.default)({ level: "silent" }),
        browser: ["Direciona SUS", "Chrome", "1.0.0"],
    });
    sock.ev.on("creds.update", saveCreds);
    // ============================================================
    // CONEXÃO
    // ============================================================
    let qrExibido = false;
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !qrExibido) {
            qrExibido = true;
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log("\n📲 *ESCANEIE ESTE QR CODE:*");
            console.log("👉 Copie e cole o LINK abaixo no navegador para ver a imagem do QR:\n");
            console.log(qrLink);
            console.log("\n🔹 Abra o link no navegador, a imagem do QR vai aparecer.");
            console.log("🔹 Escaneie a imagem com o WhatsApp do celular.");
            console.log("⏳ O QR NÃO VAI EXPIRAR AGORA – eu parei as reinicializações.\n");
            qrcode_terminal_1.default.generate(qr, { small: true });
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
                qrExibido = false;
            }
        }
        if (connection === "open") {
            console.log("✅ Bot do WhatsApp conectado com sucesso!");
            qrExibido = false;
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
        // ---- TEXTO DA MENSAGEM ----
        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";
        const cleanText = text.trim();
        // ============================================================
        // 1. CAPTURA DE LOCALIZAÇÃO
        // ============================================================
        const location = msg.message.locationMessage;
        if (location) {
            const lat = location.degreesLatitude;
            const lng = location.degreesLongitude;
            if (lat === undefined ||
                lng === undefined ||
                lat === null ||
                lng === null) {
                await sock.sendMessage(sender, {
                    text: "📍 Localização inválida. Tente compartilhar novamente usando o botão de anexo do WhatsApp.",
                });
                await sock.sendPresenceUpdate("paused", sender);
                return;
            }
            const nomeLocal = location.name || "Localização compartilhada";
            console.log(`📍 Localização recebida de [${sender}]: ${lat}, ${lng} - Nome: ${nomeLocal}`);
            const estadoAtual = sessions.get(sender);
            if (estadoAtual?.aguardandoLocalizacao?.ativo) {
                const tipo = estadoAtual.aguardandoLocalizacao.tipo;
                console.log(`🔍 Buscando ${tipo} mais próximo...`);
                try {
                    const unidades = await (0, geolocalizacao_js_1.buscarUnidadesProximas)(lat, lng, tipo);
                    let resposta = "";
                    if (unidades.length === 0) {
                        resposta =
                            `📍 Não encontrei unidades de saúde públicas próximas a você.\n\n` +
                                `Tente buscar manualmente no Google Maps:\n` +
                                `https://www.google.com/maps/search/${tipo === "HOSPITAL"
                                    ? "hospital+publico"
                                    : tipo === "UPA"
                                        ? "upa"
                                        : "ubs"}/@${lat},${lng},15z`;
                    }
                    else {
                        const tipoNome = tipo === "HOSPITAL" ? "HOSPITAL" : tipo === "UPA" ? "UPA" : "UBS";
                        resposta = `📍 *Unidades de saúde pública (${tipoNome}) mais próximas:*\n\n`;
                        unidades.forEach((unidade, index) => {
                            const distanciaKm = (unidade.distancia / 1000).toFixed(1);
                            resposta +=
                                `${index + 1}. 🏥 *${unidade.nome}*\n` +
                                    `   📌 ${unidade.endereco}\n` +
                                    `   📏 ${distanciaKm} km de distância\n` +
                                    `   🔗 [Abrir no Google Maps](${unidade.linkGoogleMaps})\n\n`;
                        });
                        resposta +=
                            `_⚠️ Recomendo ligar antes para confirmar o atendimento e horários._\n` +
                                `_Lembre-se: em emergências, acione o SAMU 192._`;
                    }
                    estadoAtual.aguardandoLocalizacao = undefined;
                    sessions.set(sender, estadoAtual);
                    await sock.sendMessage(sender, { text: resposta });
                    await sock.sendPresenceUpdate("paused", sender);
                    return;
                }
                catch (error) {
                    console.error("❌ Erro ao buscar unidades:", error);
                    await sock.sendMessage(sender, {
                        text: "❌ Ocorreu um erro ao buscar unidades próximas. Tente novamente mais tarde.",
                    });
                    await sock.sendPresenceUpdate("paused", sender);
                    return;
                }
            }
            else {
                await sock.sendMessage(sender, {
                    text: `📍 Localização recebida!\n\n` +
                        `Se quiser encontrar a UPA, Hospital ou UBS mais próxima, diga:\n` +
                        `- "Quero a UPA mais próxima"\n` +
                        `- "Quero o hospital mais próximo"\n` +
                        `- "Quero a UBS mais próxima"\n\n` +
                        `Ou continue descrevendo seus sintomas para orientação médica.`,
                });
                await sock.sendPresenceUpdate("paused", sender);
                return;
            }
        }
        // ============================================================
        // 2. SE NÃO HOUVER TEXTO, IGNORA
        // ============================================================
        if (!cleanText)
            return;
        console.log(`\n📩 Mensagem recebida de [${sender}]: "${cleanText}"`);
        // ============================================================
        // 3. COMANDO /RESET
        // ============================================================
        const textoLimpoComparacao = cleanText
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
        const deveReiniciar = comandosReset.some((cmd) => {
            const cmdLimpo = cmd.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            return textoLimpoComparacao === cmdLimpo;
        });
        if (deveReiniciar) {
            sessions.delete(sender);
            console.log(`🔄 Sessão reiniciada para [${sender}]`);
            await sock.sendMessage(sender, {
                text: `🔄 Conversa reiniciada.\n\n${MENSAGEM_BOAS_VINDAS}`,
            });
            return;
        }
        // ============================================================
        // 4. VERIFICA SE O USUÁRIO RESPONDEU "SIM" À PERGUNTA DE LOC
        // ============================================================
        const estadoAtual = sessions.get(sender);
        if (estadoAtual?.aguardandoLocalizacao?.ativo) {
            const textoSim = [
                "sim",
                "quero",
                "sim quero",
                "quero sim",
                "ok",
                "pode ser",
                "gostaria",
                "por favor",
                "manda",
            ];
            const textoNao = [
                "não",
                "nao",
                "dispensa",
                "não quero",
                "nao quero",
                "depois",
                "agora não",
            ];
            const textoLimpo = cleanText
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "");
            if (textoSim.some((s) => textoLimpo.includes(s))) {
                await sock.sendMessage(sender, {
                    text: `📍 Ótimo! Por favor, compartilhe sua localização atual usando o botão de anexo do WhatsApp (📎 → Localização).\n\n` +
                        `Isso me ajudará a encontrar a unidade mais próxima para você.`,
                });
                await sock.sendPresenceUpdate("paused", sender);
                return;
            }
            else if (textoNao.some((s) => textoLimpo.includes(s))) {
                estadoAtual.aguardandoLocalizacao = undefined;
                sessions.set(sender, estadoAtual);
                await sock.sendMessage(sender, {
                    text: "Tudo bem! Foco nos sintomas então. Posso ajudar com mais algo?",
                });
                await sock.sendPresenceUpdate("paused", sender);
                return;
            }
        }
        // ============================================================
        // 5. PROCESSA O TURNO NORMAL (IA / REGRAS)
        // ============================================================
        try {
            await sock.sendPresenceUpdate("composing", sender);
            if (!sessions.has(sender)) {
                console.log(`🆕 Criando nova sessão para [${sender}] e enviando boas-vindas.`);
                const novoEstado = JSON.parse(JSON.stringify(orquestrador_js_1.ESTADO_INICIAL));
                sessions.set(sender, novoEstado);
                await sock.sendMessage(sender, { text: MENSAGEM_BOAS_VINDAS });
                return;
            }
            console.log("⏳ Enviando dados para o orquestrador...");
            const estadoAtualProcesso = sessions.get(sender);
            const { resultado, estado: novoEstado } = await (0, orquestrador_js_1.processarTurno)(cleanText, estadoAtualProcesso);
            sessions.set(sender, novoEstado);
            console.log("📤 Resposta gerada pela IA/Regras:", JSON.stringify(resultado, null, 2));
            // ============================================================
            // 6. MONTAGEM DA RESPOSTA (com pergunta de localização)
            // ============================================================
            let mensagemFinal = resultado.texto;
            if (resultado.tipo === "orientacao") {
                const respostaId = resultado.decisao?.resposta_id;
                let tipoLocalizacao = null;
                if (respostaId === "upa_001")
                    tipoLocalizacao = "UPA";
                else if (respostaId === "emergencia_001" ||
                    respostaId === "obstetricia_001" ||
                    respostaId === "pediatria_emergencia_001" ||
                    respostaId === "mental_emergencia_001") {
                    tipoLocalizacao = "HOSPITAL";
                }
                else if (respostaId === "ubs_001")
                    tipoLocalizacao = "UBS";
                if (tipoLocalizacao) {
                    const nomeUnidade = tipoLocalizacao === "UPA"
                        ? "UPA"
                        : tipoLocalizacao === "HOSPITAL"
                            ? "hospital"
                            : "UBS";
                    mensagemFinal +=
                        `\n\n📍 *Gostaria de saber a ${nomeUnidade} mais próxima de você?* 🙋\n` +
                            `Compartilhe sua localização (botão de anexo → Localização) ou digite *"sim"* para eu te pedir a localização.`;
                    const estadoAtualApos = sessions.get(sender);
                    estadoAtualApos.aguardandoLocalizacao = {
                        ativo: true,
                        tipo: tipoLocalizacao,
                        mensagemOriginal: mensagemFinal,
                    };
                    sessions.set(sender, estadoAtualApos);
                }
            }
            // ============================================================
            // 7. ENVIA A MENSAGEM FINAL
            // ============================================================
            await sock.sendMessage(sender, { text: mensagemFinal });
        }
        catch (error) {
            console.error("❌ Erro fatal ao processar turno:", error);
            await sock.sendMessage(sender, {
                text: "❌ Ocorreu um erro ao processar sua mensagem. Tente novamente ou digite /reset.",
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
