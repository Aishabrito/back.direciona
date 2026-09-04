import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode-terminal";
import pino from "pino";
import dotenv from "dotenv";
import fs from "fs";
import http from "http";const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot do WhatsApp rodando 24/7!");
}).listen(PORT, () => {
  console.log(`🌐 Servidor de monitoramento escutando na porta ${PORT}`);
});
import path from "path";

// Garante o carregamento do .env a partir da raiz do projeto
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { processarTurno, ESTADO_INICIAL } from "../ia/orquestrador";
import type { EstadoConversa } from "../ia/tipos";

const sessions = new Map<string, EstadoConversa>();
const AUTH_DIR = "auth_info_baileys";

// Restaura credenciais da variável de ambiente no Render (evita pedir QR Code)
function restaurarSessaoSeNecessario() {
  const credsBase64 = process.env.WHATSAPP_CREDS;
  if (!credsBase64) return;

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const credsPath = path.join(AUTH_DIR, "creds.json");
  if (!fs.existsSync(credsPath)) {
    const credsJson = Buffer.from(credsBase64, "base64").toString("utf-8");
    fs.writeFileSync(credsPath, credsJson);
    console.log("🔑 Credenciais restauradas a partir da variável de ambiente!");
  }
}

export async function startWhatsAppBot() {
  restaurarSessaoSeNecessario();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }) as any),
    },
    printQRInTerminal: false,
    logger: pino({ level: "silent" }) as any,
    browser: ["Direciona SUS", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📲 Escaneie o QR Code abaixo com o WhatsApp:\n");
      QRCode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconectando...");
        startWhatsAppBot();
      } else {
        console.log("❌ Desconectado permanentemente. Delete a pasta 'auth_info_baileys' e reinicie.");
      }
    }

    if (connection === "open") {
      console.log("✅ Bot do WhatsApp conectado com sucesso!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast") return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    const cleanText = text.trim();
    if (!cleanText) return;

    console.log(`\n📩 Mensagem recebida de [${sender}]: "${cleanText}"`);

    const MENSAGEM_BOAS_VINDAS =
      "Olá! Sou o assistente virtual do *Direciona SUS* 🏥\n\n" +
      "Meu papel é orientar qual serviço do SUS você deve procurar (UBS, UPA, Pronto-Socorro ou SAMU 192).\n\n" +
      "Por favor, me conte em detalhes: *o que está acontecendo ou o que você está sentindo?*\n" +
      '_(Se quiser, você também pode tirar dúvidas como: "qual a diferença entre UBS e UPA?")_';

    // Lista com variações de reset e início
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

    const textoLimpoComparacao = cleanText
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    const deveReiniciar = comandosReset.some((cmd) => {
      const cmdLimpo = cmd
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
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

    try {
      await sock.sendPresenceUpdate("composing", sender);

      if (!sessions.has(sender)) {
        console.log(`🆕 Criando nova sessão para [${sender}] e enviando boas-vindas.`);
        const novoEstado = JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa;
        sessions.set(sender, novoEstado);
        await sock.sendMessage(sender, { text: MENSAGEM_BOAS_VINDAS });
        return;
      }

      console.log("⏳ Enviando dados para o orquestrador...");
      const estadoAtual = sessions.get(sender)!;
      const { resultado, estado: novoEstado } = await processarTurno(cleanText, estadoAtual);
      sessions.set(sender, novoEstado);

      console.log("📤 Resposta gerada pela IA/Regras:", JSON.stringify(resultado, null, 2));

      await sock.sendMessage(sender, { text: resultado.texto });
    } catch (error) {
      console.error("❌ Erro fatal ao processar turno:", error);
      await sock.sendMessage(sender, {
        text: "❌ Ocorreu um erro ao processar sua mensagem. Tente novamente ou digite /reset.",
      });
    } finally {
      await sock.sendPresenceUpdate("paused", sender);
    }
  });
}

startWhatsAppBot().catch(console.error);
