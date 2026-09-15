import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

import { processarTurno, ESTADO_INICIAL } from "../ia/orquestrador.js";
import type { EstadoConversa } from "../ia/tipos.js";
import {
  buscarUnidadesProximas,
  type UnidadeSaude,
} from "../servicos/geolocalizacao.js";
import { setQrCode } from "../index.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ============================================================
// SESSÕES EM MEMÓRIA
// ============================================================
const sessions = new Map<string, EstadoConversa>();
const AUTH_DIR = "auth_info_baileys";

// ============================================================
// RESTAURAÇÃO DE CREDENCIAIS (para Render)
// ============================================================
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

// ============================================================
// MENSAGEM DE BOAS-VINDAS
// ============================================================
const MENSAGEM_BOAS_VINDAS =
  "Olá! Sou o assistente virtual do *Direciona SUS* 🏥\n\n" +
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
export async function startWhatsAppBot() {
  restaurarSessaoSeNecessario();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: "silent" }) as any,
      ),
    },
    logger: pino({ level: "silent" }) as any,
    browser: ["Direciona SUS", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  // ============================================================
  // CONEXÃO
  // ============================================================
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      setQrCode(qr);
      console.log("\n📲 *NOVO QR CODE GERADO!*");
      console.log("👉 Abra no navegador: https://SEU-BACKEND.onrender.com/qr");
      console.log("⏳ Escaneie em até 20 segundos!\n");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== 401 &&
        statusCode !== 403
      ) {
        console.log("🔄 Reconectando...");
        startWhatsAppBot();
      } else {
        console.log(
          "❌ Desconectado permanentemente. Delete a pasta 'auth_info_baileys' e reinicie.",
        );
      }
    }

    if (connection === "open") {
      setQrCode(null);
      console.log("✅ Bot do WhatsApp conectado com sucesso!");
    }
  });

  // ============================================================
  // EVENTO DE MENSAGENS
  // ============================================================
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast")
      return;

    const text =
      msg.message.conversation ||
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
          const unidades = await buscarUnidadesProximas(lat, lng, tipo);
          let resposta = "";

          if (unidades.length === 0) {
            resposta =
              `📍 Não encontrei unidades públicas próximas.\n\n` +
              `Busque no Google Maps:\n` +
              `https://www.google.com/maps/search/${tipo}/@${lat},${lng},15z`;
          } else {
            resposta = `📍 *Unidades (${tipo}) mais próximas:*\n\n`;
            unidades.forEach((u: UnidadeSaude, i: number) => {
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
        } catch (err) {
          console.error("❌ Erro ao buscar unidades:", err);
          await sock.sendMessage(sender, {
            text: "❌ Erro ao buscar unidades próximas.",
          });
        }
        return;
      } else {
        await sock.sendMessage(sender, {
          text:
            `📍 Localização recebida!\n\n` +
            `Diga "Quero a UPA mais próxima" para eu buscar.`,
        });
        return;
      }
    }

    if (!cleanText) return;

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
          text:
            `📍 Compartilhe sua localização (📎 → Localização) para eu buscar a unidade.`,
        });
        return;
      } else if (nao.some((s) => textoLimpo.includes(s))) {
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
        const novoEstado = JSON.parse(
          JSON.stringify(ESTADO_INICIAL),
        ) as EstadoConversa;
        sessions.set(sender, novoEstado);
        await sock.sendMessage(sender, { text: MENSAGEM_BOAS_VINDAS });
        return;
      }

      const estadoAtualProcesso = sessions.get(sender)!;
      const { resultado, estado: novoEstado } = await processarTurno(
        cleanText,
        estadoAtualProcesso,
      );
      sessions.set(sender, novoEstado);

      let mensagemFinal = resultado.texto;

      if (resultado.tipo === "orientacao") {
        const respostaId = resultado.decisao?.resposta_id;
        let tipoLocalizacao: "UPA" | "HOSPITAL" | "UBS" | null = null;

        if (respostaId === "upa_001") tipoLocalizacao = "UPA";
        else if (
          ["emergencia_001", "obstetricia_001", "pediatria_emergencia_001", "mental_emergencia_001"].includes(respostaId)
        ) tipoLocalizacao = "HOSPITAL";
        else if (respostaId === "ubs_001") tipoLocalizacao = "UBS";

        if (tipoLocalizacao) {
          const nome = tipoLocalizacao === "UPA" ? "UPA" : tipoLocalizacao === "HOSPITAL" ? "hospital" : "UBS";
          mensagemFinal +=
            `\n\n📍 *Quer saber a ${nome} mais próxima?* 🙋\n` +
            `Responda *"sim"* e depois compartilhe sua localização.`;

          const estadoApos = sessions.get(sender)!;
          estadoApos.aguardandoLocalizacao = {
            ativo: true,
            tipo: tipoLocalizacao,
            mensagemOriginal: mensagemFinal,
          };
          sessions.set(sender, estadoApos);
        }
      }

      await sock.sendMessage(sender, { text: mensagemFinal });
    } catch (error) {
      console.error("❌ Erro no processamento:", error);
      await sock.sendMessage(sender, {
        text: "❌ Ocorreu um erro. Tente novamente ou digite /reset.",
      });
    } finally {
      await sock.sendPresenceUpdate("paused", sender);
    }
  });
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
startWhatsAppBot().catch(console.error);