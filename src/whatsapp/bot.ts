import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import dotenv from "dotenv";
import path from "path";

import { processarTurno, processarTurnoComRelato, ESTADO_INICIAL } from "../ia/orquestrador.js";
import { interpretarAudio } from "../ia/extrator_de_informacoes.js";
import type { EstadoConversa } from "../ia/tipos.js";
import { buscarUnidadesProximas, buscarUpaEEmergencia, formatarUnidades, type UnidadeSaude } from "../servicos/geolocalizacao.js";
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

// [FIX 2] Limpeza periódica de sessões inativas (antes o Map crescia infinito)
setInterval(() => {
  // Como não temos timestamp por sessão, limpamos só sessões já "orientado"
  // (o estado terminal) e que já foram respondidas há mais de 30 min.
  // Simplificação conservadora: mantém só as 1000 sessões mais recentes.
  if (sessions.size > 1000) {
    const excesso = sessions.size - 1000;
    const chaves = sessions.keys();
    for (let i = 0; i < excesso; i++) {
      const k = chaves.next().value;
      if (k) sessions.delete(k);
    }
  }
}, 5 * 60 * 1000).unref?.();

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
// PEDIDO EXPLÍCITO DE LOCALIZAÇÃO
// ============================================================
function detectarPedidoLocalizacao(texto: string): 'UPA' | 'HOSPITAL' | 'UBS' | null {
  const n = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const temPalavraLocal =
    /\b(onde|qual|perto|proxim|endereco|localiza|fica|me manda|me passa|tem algum|existe|quero|preciso)\b/.test(n);
  if (!temPalavraLocal) return null;
  if (/\b(upa|pronto\s*socorro|pronto-socorro|emergencia)\b/.test(n)) return 'UPA';
  if (/\b(hospital|hospitalar)\b/.test(n)) return 'HOSPITAL';
  if (/\b(ubs|posto\s*de\s*saude|posto|clinica|clinica\s*da\s*familia)\b/.test(n)) return 'UBS';
  return null;
}

function matchSimNao(textoLimpo: string): "sim" | "nao" | null {
  const norm = textoLimpo.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (/^(sim|quero|ok|claro|bora|manda|pode|vamos|aceito|por favor|pfv|pf)\b/.test(norm)) return "sim";
  if (/^(nao|dispensa|depois|agora nao|n)\b/.test(norm)) return "nao";
  return null;
}

async function buscarParaTipo(
  lat: number, lng: number, tipo: 'UPA' | 'HOSPITAL' | 'UBS',
): Promise<UnidadeSaude[]> {
  if (tipo === 'HOSPITAL') {
    const { upas, emergencias } = await buscarUpaEEmergencia(lat, lng);
    return [...emergencias, ...upas];
  }
  return buscarUnidadesProximas(lat, lng, tipo);
}

// ============================================================
// OFERECE LOCALIZAÇÃO APÓS UMA ORIENTAÇÃO
// ============================================================
function oferecerLocalizacao(
  sender: string,
  resultado: { tipo: string; decisao?: { resposta_id: string } },
  mensagemBase: string,
): string {
  if (resultado.tipo !== 'orientacao' || !resultado.decisao) return mensagemBase;

  const respostaId = resultado.decisao.resposta_id;
  let tipoLocalizacao: 'UPA' | 'HOSPITAL' | 'UBS' | null = null;

  if (respostaId === 'upa_001') tipoLocalizacao = 'UPA';
  else if (['emergencia_001','obstetricia_001','pediatria_emergencia_001','mental_emergencia_001'].includes(respostaId))
    tipoLocalizacao = 'HOSPITAL';
  else if (respostaId === 'ubs_001') tipoLocalizacao = 'UBS';

  if (!tipoLocalizacao) return mensagemBase;

  const nome = tipoLocalizacao === 'UPA' ? 'UPA' : tipoLocalizacao === 'HOSPITAL' ? 'hospital' : 'UBS';
  const texto =
    mensagemBase +
    `\n\n📍 *Quer saber ${tipoLocalizacao === 'UBS' ? 'a' : 'o'} ${nome} mais ${tipoLocalizacao === 'UBS' ? 'próxima' : 'próximo'}?* 🙋\n` +
    `Responda *"sim"* e depois compartilhe sua localização.`;

  const estadoApos = sessions.get(sender)!;
  estadoApos.aguardandoLocalizacao = { ativo: true, tipo: tipoLocalizacao, mensagemOriginal: texto };
  sessions.set(sender, estadoApos);
  return texto;
}

// [FIX 1] Backoff entre reconexões (antes era recursão direta sem delay)
let tentativasReconexao = 0;
const MAX_BACKOFF_MS = 60_000;

// ============================================================
// BOT
// ============================================================
export async function startWhatsAppBot() {
  const sql: Sql | null = await criarClienteDb();
  await baixarSessaoParaDisco(sql);
  iniciarSyncPeriodico(sql);
  registrarSyncNoShutdown(sql);

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
      const permanente =
        statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;

      if (!permanente) {
        // [FIX 1] Espera crescente antes de tentar de novo
        const espera = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, tentativasReconexao));
        tentativasReconexao++;
        console.log(`🔄 Reconectando em ${espera / 1000}s (tentativa ${tentativasReconexao})...`);
        setTimeout(() => startWhatsAppBot().catch(console.error), espera);
      } else {
        console.log("❌ Desconectado permanentemente.");
      }
    }

    if (connection === "open") {
      setQrCode(null);
      tentativasReconexao = 0;
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
          console.log(`🔍 Buscando ${tipo} para (${lat}, ${lng})`);
          const unidades = await buscarParaTipo(lat, lng, tipo);
          console.log(`📦 ${unidades.length} unidades retornadas`);
          const resposta = formatarUnidades(unidades, lat, lng);

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

    // ============================================================
    // ÁUDIO — interpreta DIRETO no Gemini
    // ============================================================
    const audioMessage = msg.message.audioMessage;
    if (audioMessage) {
      try {
        await sock.sendPresenceUpdate("composing", sender);

        const buffer = (await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: pino({ level: 'silent' }) as any,
            reuploadRequest: sock.updateMediaMessage,
          },
        )) as Buffer;

        if (!buffer || buffer.length === 0) throw new Error('Buffer de áudio vazio');

        const mime = audioMessage.mimetype || 'audio/ogg; codecs=opus';
        console.log(`🎤 [${sender}] Áudio recebido (${(buffer.length / 1024).toFixed(1)} KB)`);

        const relatoDoAudio = await interpretarAudio(buffer, mime);

        const primeiraMensagemAudio = !sessions.has(sender);
        if (primeiraMensagemAudio) {
          sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
        }
        const estadoAtualAudio = sessions.get(sender)!;

        const { resultado, estado: novoEstado } = await processarTurnoComRelato(
          '[áudio]', relatoDoAudio, estadoAtualAudio,
        );
        sessions.set(sender, novoEstado);

        let respostaAudio = resultado.texto;
        if (primeiraMensagemAudio) {
          respostaAudio = `${MENSAGEM_BOAS_VINDAS}\n\n---\n\n${respostaAudio}`;
        }

        respostaAudio = oferecerLocalizacao(sender, resultado, respostaAudio);

        await sock.sendMessage(sender, { text: respostaAudio });
        await sock.sendPresenceUpdate("paused", sender);
        return;
      } catch (err) {
        console.error('❌ Erro ao processar áudio:', err);
        await sock.sendMessage(sender, {
          text: '🎤 Não consegui entender esse áudio. Pode repetir ou escrever? Em emergência, ligue 192.',
        });
        await sock.sendPresenceUpdate("paused", sender);
        return;
      }
    }

    if (!cleanText) return;

    console.log(`\n📩 [${sender}] ${cleanText}`);

    const textoLimpo = cleanText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // RESET
    if (comandosReset.some((cmd) => {
      const cmdLimpo = cmd.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return textoLimpo === cmdLimpo;
    })) {
      sessions.delete(sender);
      await sock.sendMessage(sender, { text: `🔄 Reiniciado.\n\n${MENSAGEM_BOAS_VINDAS}` });
      return;
    }

    // ============================================================
    // [FIX 3] SIM/NÃO quando aguarda localização
    // Antes: qualquer "sim" ou "não" era capturado, mesmo que viesse
    // acompanhado de sintoma grave ("não, agora estou com falta de ar").
    // Agora: só intercepta se for curto E sem palavra clínica.
    // ============================================================
    const estadoAtualSimNao = sessions.get(sender);
    if (estadoAtualSimNao?.aguardandoLocalizacao?.ativo) {
      const decisao = matchSimNao(textoLimpo);
      const palavras = textoLimpo.split(/\s+/).filter(Boolean);
      const temPalavraClinica = /\b(dor|falta de ar|desmaio|sangramento|febre|vomito|confus|tontura|peito|respir|convuls|acidente|queimad|trauma|pior|piorou|sinto)\b/.test(textoLimpo);
      const podeSerSimNao = decisao !== null && palavras.length <= 4 && !temPalavraClinica;

      if (podeSerSimNao) {
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

      // Se veio sintoma ou texto longo, cancela a espera de localização
      // e deixa a mensagem seguir para a triagem normal.
      estadoAtualSimNao.aguardandoLocalizacao = undefined;
      sessions.set(sender, estadoAtualSimNao);
    }

    // PEDIDO EXPLÍCITO DE LOCALIZAÇÃO
    const pedidoLoc = detectarPedidoLocalizacao(cleanText);
    if (pedidoLoc) {
      const estado = sessions.get(sender) ?? (JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
      estado.aguardandoLocalizacao = { ativo: true, tipo: pedidoLoc, mensagemOriginal: cleanText };
      sessions.set(sender, estado);
      const nome = pedidoLoc === "UPA" ? "UPA" : pedidoLoc === "HOSPITAL" ? "hospital" : "UBS";
      await sock.sendMessage(sender, {
        text: `📍 Compartilhe sua localização (📎 → Localização) que eu busco ${pedidoLoc === 'UBS' ? 'a' : 'o'} ${nome} mais ${pedidoLoc === 'UBS' ? 'próxima' : 'próximo'}.`,
      });
      return;
    }

    // PROCESSA TURNO TEXTO
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

      mensagemFinal = oferecerLocalizacao(sender, resultado, mensagemFinal);

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