import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import dotenv from "dotenv";
import path from "path";

import { processarTurno, ESTADO_INICIAL } from "../ia/orquestrador.js";
import type { EstadoConversa } from "../ia/tipos.js";
import { buscarUnidadesProximas, type UnidadeSaude } from "../servicos/geolocalizacao.js";
import { setQrCode } from "../index.js";
import {
  criarClienteDb,
  baixarSessaoParaDisco,
  iniciarSyncPeriodico,
  registrarSyncNoShutdown,
  type Sql,
} from "./persistencia_sessao.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const sessions = new Map<string, EstadoConversa>();
const AUTH_DIR = "auth_info_baileys";

const MENSAGEM_BOAS_VINDAS =
  "Olá! Sou o assistente virtual do *Direciona SUS* 🏥\n\n" +
  "Meu papel é orientar qual serviço do SUS você deve procurar (UBS, UPA, Pronto-Socorro ou SAMU 192).\n\n" +
  "Por favor, me conte em detalhes: *o que está acontecendo ou o que você está sentindo?*\n" +
  '_(Se quiser, você também pode tirar dúvidas como: "qual a diferença entre UBS e UPA?")_';

const comandosReset = [
  "/reset", "reset", "reiniciar", "comecar de novo", "começar de novo", "comecar dnv",
  "vamos comecar dnv", "vamos começar de novo", "voltar pro inicio", "voltar para o inicio",
  "voltar ao inicio", "inicio", "início", "menu", "cancelar",
];

// ============================================================
// DETECTA PEDIDO EXPLÍCITO DE LOCALIZAÇÃO
// ============================================================
function detectarPedidoLocalizacao(texto: string): 'UPA' | 'HOSPITAL' | 'UBS' | null {
  const n = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const temPalavraLocal = /\b(onde|qual|perto|proxim|endereco|localiza|fica|me manda|me passa|tem algum|existe)\b/.test(n);
  if (!temPalavraLocal) return null;

  if (/\b(upa|pronto\s*socorro|pronto-socorro|emergencia)\b/.test(n)) return 'UPA';
  if (/\b(hospital|hospitalar)\b/.test(n)) return 'HOSPITAL';
  if (/\b(ubs|posto\s*de\s*saude|posto|clinica)\b/.test(n)) return 'UBS';

  return null;
}

// ============================================================
// DETECTA SIM/NÃO POR TOKEN (não por substring)
// ============================================================
function matchSimNao(textoLimpo: string): "sim" | "nao" | null {
  const norm = textoLimpo.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (/^(sim|quero|ok|claro|bora|manda|pode|vamos|aceito|por favor|pfv|pf)\b/.test(norm)) return "sim";
  if (/^(nao|dispensa|depois|agora nao|n)\b/.test(norm)) return "nao";
  return null;
}

// ============================================================
// FORMATA LISTA DE UNIDADES
// ============================================================
function formatarUnidades(
  unidades: UnidadeSaude[],
  tipo: 'UPA' | 'HOSPITAL' | 'UBS',
  lat: number,
  lng: number,
): string {
  if (unidades.length === 0) {
    return (
      `📍 Não encontrei unidades públicas próximas.\n\n` +
      `Busque no Google Maps:\n` +
      `https://www.google.com/maps/search/${tipo}/@${lat},${lng},15z`
    );
  }

  let resposta = `📍 *${tipo === "UPA" ? "UPAs" : tipo === "HOSPITAL" ? "Hospitais" : "UBS"} mais próximas:*\n\n`;
  unidades.forEach((u, i) => {
    resposta +=
      `${i + 1}. 🏥 *${u.nome}*\n` +
      `   📌 ${u.endereco}\n` +
      `   📏 ${(u.distancia / 1000).toFixed(1)} km\n` +
      `   🔗 ${u.linkGoogleMaps}\n\n`;
  });
  resposta += `_⚠️ Ligue antes para confirmar atendimento._`;
  return resposta;
}

// ============================================================
// INICIALIZA O BOT
// ============================================================
export async function startWhatsAppBot() {
  // 1. Conecta ao banco (ou null se DATABASE_URL não estiver setada)
  const sql: Sql | null = await criarClienteDb();

  // 2. Baixa a sessão do banco para o disco local (antes do Baileys ler)
  await baixarSessaoParaDisco(sql);

  // 3. Agenda sync periódico (30s) e no shutdown
  iniciarSyncPeriodico(sql);
  registrarSyncNoShutdown(sql);

  // 4. Inicializa o Baileys normalmente
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }) as any),
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
      console.log("👉 Abra no navegador: https://back-direciona.onrender.com/qr");
      console.log("⏳ Escaneie em até 20 segundos!\n");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut && statusCode !== 401 && statusCode !== 403) {
        console.log("🔄 Reconectando...");
        startWhatsAppBot();
      } else {
        console.log("❌ Desconectado permanentemente.");
      }
    }

    if (connection === "open") {
      setQrCode(null);
      console.log("✅ Bot do WhatsApp conectado com sucesso!");
    }
  });

  // ============================================================
  // MENSAGENS
  // ============================================================
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

    // ============================================================
    // LOCALIZAÇÃO RECEBIDA
    // ============================================================
    const location = msg.message.locationMessage;
    if (location) {
      const lat = location.degreesLatitude;
      const lng = location.degreesLongitude;

      if (lat == null || lng == null) {
        await sock.sendMessage(sender, { text: "📍 Localização inválida. Tente novamente." });
        return;
      }

      const estadoAtual = sessions.get(sender);
      if (estadoAtual?.aguardandoLocalizacao?.ativo) {
        const tipo = estadoAtual.aguardandoLocalizacao.tipo;
        try {
          await sock.sendPresenceUpdate("composing", sender);
          const unidades = await buscarUnidadesProximas(lat, lng, tipo);
          const resposta = formatarUnidades(unidades, tipo, lat, lng);

          estadoAtual.aguardandoLocalizacao = undefined;
          sessions.set(sender, estadoAtual);
          await sock.sendMessage(sender, { text: resposta });
        } catch (err) {
          console.error("❌ Erro ao buscar unidades:", err);
          await sock.sendMessage(sender, { text: "❌ Erro ao buscar unidades próximas." });
        }
        return;
      }

      await sock.sendMessage(sender, {
        text: `📍 Localização recebida!\n\nDiga *"quero a UPA mais próxima"* que eu busco.`,
      });
      return;
    }

    if (!cleanText) return;

    console.log(`\n📩 [${sender}] ${cleanText}`);

    const textoLimpo = cleanText
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    // ============================================================
    // RESET
    // ============================================================
    if (
      comandosReset.some((cmd) => {
        const cmdLimpo = cmd.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return textoLimpo === cmdLimpo;
      })
    ) {
      sessions.delete(sender);
      await sock.sendMessage(sender, {
        text: `🔄 Reiniciado.\n\n${MENSAGEM_BOAS_VINDAS}`,
      });
      return;
    }

    // ============================================================
    // RESPONDE SIM/NÃO QUANDO AGUARDA LOCALIZAÇÃO
    // ============================================================
    const estadoAtualSimNao = sessions.get(sender);
    if (estadoAtualSimNao?.aguardandoLocalizacao?.ativo) {
      const decisao = matchSimNao(textoLimpo);
      if (decisao === "sim") {
        await sock.sendMessage(sender, {
          text: `📍 Compartilhe sua localização (📎 → Localização) que eu busco a unidade mais próxima.`,
        });
        return;
      }
      if (decisao === "nao") {
        estadoAtualSimNao.aguardandoLocalizacao = undefined;
        sessions.set(sender, estadoAtualSimNao);
        await sock.sendMessage(sender, { text: "Tudo bem! Posso ajudar com mais algo?" });
        return;
      }
    }

    // ============================================================
    // PEDIDO EXPLÍCITO DE LOCALIZAÇÃO
    // ============================================================
    const pedidoLoc = detectarPedidoLocalizacao(cleanText);
    if (pedidoLoc) {
      const estado = sessions.get(sender) ?? (JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
      estado.aguardandoLocalizacao = {
        ativo: true,
        tipo: pedidoLoc,
        mensagemOriginal: cleanText,
      };
      sessions.set(sender, estado);
      const nome = pedidoLoc === "UPA" ? "UPA" : pedidoLoc === "HOSPITAL" ? "hospital" : "UBS";
      await sock.sendMessage(sender, {
        text: `📍 Compartilhe sua localização (📎 → Localização) que eu busco o ${nome} mais próximo.`,
      });
      return;
    }

    // ============================================================
    // PROCESSA TURNO
    // ============================================================
    try {
      await sock.sendPresenceUpdate("composing", sender);

      const primeiraMensagem = !sessions.has(sender);
      if (primeiraMensagem) {
        sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
      }

      const estadoAtualProcesso = sessions.get(sender)!;
      const { resultado, estado: novoEstado } = await processarTurno(cleanText, estadoAtualProcesso);
      sessions.set(sender, novoEstado);

      let mensagemFinal = resultado.texto;
      if (primeiraMensagem) {
        mensagemFinal = `${MENSAGEM_BOAS_VINDAS}\n\n---\n\n${mensagemFinal}`;
      }

      // OFERECE LOCALIZAÇÃO PARA RESPOSTAS DE ORIENTAÇÃO
      if (resultado.tipo === "orientacao") {
        const respostaId = resultado.decisao?.resposta_id;
        let tipoLocalizacao: "UPA" | "HOSPITAL" | "UBS" | null = null;

        if (respostaId === "upa_001") tipoLocalizacao = "UPA";
        else if (
          ["emergencia_001", "obstetricia_001", "pediatria_emergencia_001", "mental_emergencia_001"].includes(respostaId)
        )
          tipoLocalizacao = "HOSPITAL";
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

startWhatsAppBot().catch(console.error);