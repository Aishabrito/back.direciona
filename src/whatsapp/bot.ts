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
import http from "http";
import path from "path";

// ===== SERVIDOR DE MONITORAMENTO (para Render) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot do WhatsApp rodando 24/7!");
}).listen(PORT, () => {
  console.log(`🌐 Servidor de monitoramento escutando na porta ${PORT}`);
});

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { processarTurno, ESTADO_INICIAL } from "../ia/orquestrador";
import type { EstadoConversa } from "../ia/tipos";
import { buscarUnidadesProximas, type UnidadeSaude } from "../servicos/geolocalizacao";

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
// MENSAGEM DE BOAS‑VINDAS
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
  "inicio", "início", "menu", "cancelar"
];

// ============================================================
// FUNÇÃO PRINCIPAL DO BOT
// ============================================================
export async function startWhatsAppBot() {
  // 🔥 FORÇA LIMPEZA se não houver credenciais
  if (!process.env.WHATSAPP_CREDS) {
    if (fs.existsSync(AUTH_DIR)) {
      console.log("🧹 Nenhuma credencial fornecida. Removendo pasta de autenticação antiga...");
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  }

  restaurarSessaoSeNecessario();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }) as any),
    },
    printQRInTerminal: true,
    logger: pino({ level: "silent" }) as any,
    browser: ["Direciona SUS", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  // ============================================================
  // CONEXÃO (COM GERADOR DE LINK PARA IMAGEM DO QR)
  // ============================================================
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // 🔥 GERANDO LINK DIRETO PARA A IMAGEM DO QR CODE
      const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;

      console.log("\n📲 *ESCANEIE ESTE QR CODE:*");
      console.log("👉 Copie e cole o LINK abaixo no navegador para ver a imagem do QR:\n");
      console.log(qrLink);
      console.log("\n🔹 Abra o link no navegador, a imagem do QR vai aparecer.");
      console.log("🔹 Escaneie a imagem com o WhatsApp do celular (WhatsApp Web).");
      console.log("⚠️ O QR expira em 30 segundos! Seja rápido.\n");
      console.log("(Caso prefira, QR ASCII abaixo, mas use o link acima!)\n");

      // Mantém o ASCII como fallback
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

  // ============================================================
  // EVENTO DE MENSAGENS
  // ============================================================
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast") return;

    // ---- TEXTO DA MENSAGEM ----
    const text =
      msg.message.conversation ||
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

      // 🔧 CORREÇÃO 1: valida se lat/lng são números
      if (lat === undefined || lng === undefined || lat === null || lng === null) {
        await sock.sendMessage(sender, {
          text: "📍 Localização inválida. Tente compartilhar novamente usando o botão de anexo do WhatsApp."
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
          const unidades = await buscarUnidadesProximas(lat, lng, tipo);

          let resposta = "";
          if (unidades.length === 0) {
            resposta =
              `📍 Não encontrei unidades de saúde públicas próximas a você.\n\n` +
              `Tente buscar manualmente no Google Maps:\n` +
              `https://www.google.com/maps/search/${tipo === "HOSPITAL" ? "hospital+publico" : tipo === "UPA" ? "upa" : "ubs"}/@${lat},${lng},15z`;
          } else {
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

          // Limpa o estado de localização
          estadoAtual.aguardandoLocalizacao = undefined;
          sessions.set(sender, estadoAtual);

          await sock.sendMessage(sender, { text: resposta });
          await sock.sendPresenceUpdate("paused", sender);
          return;
        } catch (error) {
          console.error("❌ Erro ao buscar unidades:", error);
          await sock.sendMessage(sender, {
            text: "❌ Ocorreu um erro ao buscar unidades próximas. Tente novamente mais tarde."
          });
          await sock.sendPresenceUpdate("paused", sender);
          return;
        }
      } else {
        // Não estava aguardando localização
        await sock.sendMessage(sender, {
          text:
            `📍 Localização recebida!\n\n` +
            `Se quiser encontrar a UPA, Hospital ou UBS mais próxima, diga:\n` +
            `- "Quero a UPA mais próxima"\n` +
            `- "Quero o hospital mais próximo"\n` +
            `- "Quero a UBS mais próxima"\n\n` +
            `Ou continue descrevendo seus sintomas para orientação médica.`
        });
        await sock.sendPresenceUpdate("paused", sender);
        return;
      }
    }

    // ============================================================
    // 2. SE NÃO HOUVER TEXTO, IGNORA
    // ============================================================
    if (!cleanText) return;

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
      const textoSim = ["sim", "quero", "sim quero", "quero sim", "ok", "pode ser", "gostaria", "por favor", "manda"];
      const textoNao = ["não", "nao", "dispensa", "não quero", "nao quero", "depois", "agora não"];

      const textoLimpo = cleanText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      if (textoSim.some(s => textoLimpo.includes(s))) {
        // Usuário disse sim → pede a localização
        await sock.sendMessage(sender, {
          text:
            `📍 Ótimo! Por favor, compartilhe sua localização atual usando o botão de anexo do WhatsApp (📎 → Localização).\n\n` +
            `Isso me ajudará a encontrar a unidade mais próxima para você.`
        });
        // Mantém o estado ativo (aguardando a localização)
        await sock.sendPresenceUpdate("paused", sender);
        return;
      } else if (textoNao.some(s => textoLimpo.includes(s))) {
        // Usuário disse não → cancela
        estadoAtual.aguardandoLocalizacao = undefined;
        sessions.set(sender, estadoAtual);
        await sock.sendMessage(sender, {
          text: "Tudo bem! Foco nos sintomas então. Posso ajudar com mais algo?"
        });
        await sock.sendPresenceUpdate("paused", sender);
        return;
      }
      // Se não for sim nem não, continua o fluxo normal (pode ser outra queixa)
    }

    // ============================================================
    // 5. PROCESSA O TURNO NORMAL (IA / REGRAS)
    // ============================================================
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
      const estadoAtualProcesso = sessions.get(sender)!;
      const { resultado, estado: novoEstado } = await processarTurno(cleanText, estadoAtualProcesso);
      sessions.set(sender, novoEstado);

      console.log("📤 Resposta gerada pela IA/Regras:", JSON.stringify(resultado, null, 2));

      // ============================================================
      // 6. MONTAGEM DA RESPOSTA (com pergunta de localização)
      // ============================================================
      let mensagemFinal = resultado.texto;

      if (resultado.tipo === "orientacao") {
        const respostaId = resultado.decisao?.resposta_id;

        // Decide qual tipo de unidade perguntar
        let tipoLocalizacao: "UPA" | "HOSPITAL" | "UBS" | null = null;

        if (respostaId === "upa_001") tipoLocalizacao = "UPA";
        else if (respostaId === "emergencia_001" || respostaId === "obstetricia_001" || respostaId === "pediatria_emergencia_001" || respostaId === "mental_emergencia_001") {
          tipoLocalizacao = "HOSPITAL";
        } else if (respostaId === "ubs_001") tipoLocalizacao = "UBS";

        if (tipoLocalizacao) {
          const nomeUnidade = tipoLocalizacao === "UPA" ? "UPA" : tipoLocalizacao === "HOSPITAL" ? "hospital" : "UBS";
          mensagemFinal +=
            `\n\n📍 *Gostaria de saber a ${nomeUnidade} mais próxima de você?* 🙋\n` +
            `Compartilhe sua localização (botão de anexo → Localização) ou digite *"sim"* para eu te pedir a localização.`;

          // Marca no estado que está aguardando localização
          const estadoAtualApos = sessions.get(sender)!;
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

// ============================================================
// INICIALIZAÇÃO
// ============================================================
startWhatsAppBot().catch(console.error);