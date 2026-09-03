// src/whatsapp/bot.ts
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode-terminal";
import pino from "pino";
import { processarTurno, ESTADO_INICIAL } from "../ia/orquestrador.js";
import type { EstadoConversa } from "../ia/tipos.js";

// Armazena a sessão usando o remoteJid (número do usuário) como chave
const sessions = new Map<string, EstadoConversa>();

export async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Direciona SUS", "Chrome", "1.0.0"],
    logger: pino({ level: "silent" }) as any,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      QRCode.generate(qr, { small: true });
      console.log("📱 Escaneie o QR Code acima com o WhatsApp.");
    }
    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔄 Reconectando...");
        startWhatsAppBot();
      } else {
        console.log("❌ Logout forçado. Remova a pasta auth_info_baileys e reinicie.");
      }
    }
    if (connection === "open") {
      console.log("✅ Bot do WhatsApp conectado!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    // Identificador único do usuário no WhatsApp
    const sender = msg.key.remoteJid!;

    // Ignora grupos para não misturar sessões de diferentes usuários
    if (sender.endsWith("@g.us")) return;

    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    text = text.trim();
    if (!text) return;

    const MENSAGEM_BOAS_VINDAS = 
      "Olá! Sou o assistente virtual do *Direciona SUS* 🏥\n\n" +
      "Meu papel é orientar qual serviço do SUS você deve procurar (UBS, UPA, Pronto-Socorro ou SAMU 192).\n\n" +
      "Por favor, me conte em detalhes: *o que está acontecendo ou o que você está sentindo?*\n" +
      "_(Se quiser, você também pode tirar dúvidas como: \"qual a diferença entre UBS e UPA?\")_";

    if (text.toLowerCase() === "/reset") {
      sessions.delete(sender);
      await sock.sendMessage(sender, {
        text: `🔄 Conversa reiniciada.\n\n${MENSAGEM_BOAS_VINDAS}`,
      });
      return;
    }

    try {
      // 1. Primeira interação (ex: clique no link/QR code com mensagem padrão)
      if (!sessions.has(sender)) {
        const novoEstado = JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa;
        sessions.set(sender, novoEstado);

        await sock.sendMessage(sender, { text: MENSAGEM_BOAS_VINDAS });
        return;
      }

      // 2. Mensagens subsequentes: executa a triagem normalmente
      const estadoAtual = sessions.get(sender)!;
      const { resultado, estado: novoEstado } = await processarTurno(text, estadoAtual);
      sessions.set(sender, novoEstado);

      await sock.sendMessage(sender, { text: resultado.texto });
    } catch (error) {
      console.error("❌ Erro ao processar:", error);
      await sock.sendMessage(sender, {
        text: "❌ Ocorreu um erro ao processar sua mensagem. Tente novamente ou digite /reset.",
      });
    }
  });
}