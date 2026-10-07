import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { registrarClienteDb } from "../ia/base_conhecimento.js";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { createHash } from "crypto";
import { ESTADO_INICIAL } from "../ia/orquestrador.js";
import { mensagemPorId } from "../ia/mensagens.js";
import type { EstadoConversa } from "../ia/tipos.js";
import { textoParaAudio } from "../servicos/texto_para_audio.js";
import { inc } from "../servicos/metricas.js";
import { setQrCode } from "../servicos/qr.js";
import { setEstadoConexao, registrarDesconexao } from "../servicos/status_whatsapp.js";
import {
  criarClienteDb, baixarSessaoParaDisco, iniciarSyncPeriodico, registrarSyncNoShutdown, apagarSessao, type Sql,
} from "./persistencia_sessao.js";
import {
  salvarEstado, carregarEstado, apagarEstado,
} from "./persistencia_estado.js";
import {
  atenderTexto, atenderAudio, atenderLocalizacao, type Canal, type Mensagem,
} from "../atendimento/atendimento.js";

// Só o que é específico do WhatsApp fica aqui (conexão, QR, mídia, nota de voz).
// A conversa em si (comandos, localização, triagem) está em atendimento/atendimento.ts,
// a mesma usada pelo app.

// Reexportado para os testes de comandos.
export { ehComandoReset } from "../atendimento/atendimento.js";

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000';

const sessions = new Map<string, EstadoConversa>();

const ultimaAtividade = new Map<string, number>();
const TTL_SESSAO_MS = 6 * 60 * 60 * 1000;

const filas = new Map<string, Promise<void>>();

function hashSender(sender: string): string {
  return createHash('sha256').update(sender).digest('hex').slice(0, 8);
}

function expirarSessaoSeVelha(sender: string): void {
  const ultima = ultimaAtividade.get(sender);
  if (ultima && Date.now() - ultima > TTL_SESSAO_MS) sessions.delete(sender);
  ultimaAtividade.set(sender, Date.now());
}

const AUTH_DIR = "auth_info_baileys";

let botIniciado = false;
let socketAtual: ReturnType<typeof makeWASocket> | null = null;
let sqlCliente: Sql | null = null;
let syncIniciado = false;
let encerrando = false;

setInterval(() => {
  if (sessions.size > 1000) {
    const excesso = sessions.size - 1000;
    const chaves = sessions.keys();
    for (let i = 0; i < excesso; i++) {
      const k = chaves.next().value;
      if (k) sessions.delete(k);
    }
  }
}, 5 * 60 * 1000).unref?.();

// Toda mudança de estado passa por aqui: memória + banco (sobrevive a restart).
async function persistir(sender: string, estado: EstadoConversa): Promise<void> {
  sessions.set(sender, estado);
  if (sqlCliente) await salvarEstado(sqlCliente, sender, estado);
}

async function obterOuCriarEstado(
  sender: string,
): Promise<{ estado: EstadoConversa; primeiraVez: boolean }> {
  const emMemoria = sessions.get(sender);
  if (emMemoria) return { estado: emMemoria, primeiraVez: false };

  if (sqlCliente) {
    const doBanco = await carregarEstado(sqlCliente, sender);
    if (doBanco) {
      sessions.set(sender, doBanco);
      return { estado: doBanco, primeiraVez: false };
    }
  }

  const novo = JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa;
  sessions.set(sender, novo);
  return { estado: novo, primeiraVez: true };
}

type Sock = ReturnType<typeof makeWASocket>;

function iniciarDigitando(sock: Sock, sender: string): () => void {
  let ativo = true;
  const tick = async () => {
    if (!ativo) return;
    try { await sock.sendPresenceUpdate("composing", sender); } catch {}
    if (ativo) setTimeout(tick, 3000);
  };
  tick();
  return () => {
    ativo = false;
    try { sock.sendPresenceUpdate("paused", sender).catch(() => {}); } catch {}
  };
}

async function responder(
  sock: Sock,
  sender: string,
  texto: string,
  falaAudio?: string,
): Promise<void> {
  await sock.sendMessage(sender, { text: texto });
  if (!falaAudio) return;

  const inicio = Date.now();
  try {
    await sock.sendPresenceUpdate("recording", sender).catch(() => {});
    const audio = await textoParaAudio(falaAudio, 'feminina');
    if (audio && audio.length > 0) {
      console.log(`🎤 [${hashSender(sender)}] Áudio de resposta (${(audio.length / 1024).toFixed(1)} KB) em ${Date.now() - inicio} ms`);
      inc('gemini_tts_ok');
      await sock.sendMessage(sender, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    } else {
      inc('gemini_tts_erro');
    }
  } catch (err) {
    console.error('❌ Falha ao gerar áudio:', err);
    inc('gemini_tts_erro');
  } finally {
    await sock.sendPresenceUpdate("paused", sender).catch(() => {});
  }
}

let tentativasReconexao = 0;
const MAX_BACKOFF_MS = 60_000;
let reconexaoAgendada = false;

function agendarReconexao(esperaMinima = 0) {
  if (reconexaoAgendada || encerrando) return;
  reconexaoAgendada = true;
  setEstadoConexao('reconectando');

  const espera = Math.max(esperaMinima, Math.min(MAX_BACKOFF_MS, 2000 * Math.pow(2, tentativasReconexao)));
  tentativasReconexao++;
  console.log(`🔄 Reconectando em ${espera / 1000}s (tentativa ${tentativasReconexao})...`);

  setTimeout(() => {
    reconexaoAgendada = false;
    if (socketAtual) {
      try { socketAtual.end(undefined); } catch {}
      socketAtual = null;
    }
    startWhatsAppBot().catch((err) => console.error('❌ Erro na reconexão:', err));
  }, espera);
}

export async function startWhatsAppBot(): Promise<void> {
  if (socketAtual) {
    console.warn('⚠️ Já existe um socket ativo. Ignorando chamada duplicada.');
    return;
  }

  if (!sqlCliente) {
    sqlCliente = await criarClienteDb();
  }
  const sql = sqlCliente;
  registrarClienteDb(sql);

  if (!botIniciado) {
    await baixarSessaoParaDisco(sql);
  }

  if (!syncIniciado) {
    iniciarSyncPeriodico(sql);
    registrarSyncNoShutdown(sql, () => {
      encerrando = true;
      try { socketAtual?.end(undefined); } catch {}
      socketAtual = null;
    });
    syncIniciado = true;
  }

  botIniciado = true;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }) as any),
    },
    logger: pino({ level: "silent" }) as any,
    browser: ["Direciona.Ai", "Chrome", "1.0.0"],
  });

  socketAtual = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      setQrCode(qr);
      setEstadoConexao('aguardando_qr');
      console.log("\n📲 *NOVO QR CODE GERADO!*");
      console.log(`👉 Abra no navegador: ${PUBLIC_URL}/qr`);
      console.log("⏳ Escaneie em até 20 segundos!\n");
    }

    if (connection === "close") {
      // Socket antigo (já substituído numa reconexão): não mexe no estado do atual.
      if (socketAtual !== sock) return;
      socketAtual = null;
      if (encerrando) return;

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode ?? null;
      const motivo = lastDisconnect?.error?.message ?? 'desconhecido';
      registrarDesconexao(statusCode, motivo);
      console.log(`⚠️ WhatsApp desconectado (código ${statusCode ?? '?'}: ${motivo})`);

      if (statusCode === DisconnectReason.loggedOut) {
        // O aparelho foi desconectado no celular (ou a sessão ficou inválida).
        // Apaga a sessão salva e reinicia para gerar um QR Code novo em /qr.
        console.log(`❌ Sessão encerrada pelo WhatsApp. Apagando a sessão salva; escaneie o novo QR em ${PUBLIC_URL}/qr`);
        tentativasReconexao = 0;
        apagarSessao(sqlCliente)
          .catch((err) => console.error('❌ Erro ao apagar sessão:', err))
          .finally(() => agendarReconexao());
      } else if (statusCode === DisconnectReason.forbidden) {
        console.log("❌ WhatsApp recusou a conta (403). Verifique o número do bot no celular.");
        setEstadoConexao('parado');
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        // Outra instância abriu a mesma sessão (ex.: deploy sobreposto).
        // Espera mais antes de voltar, para as duas não ficarem se derrubando.
        agendarReconexao(MAX_BACKOFF_MS);
      } else {
        agendarReconexao();
      }
    }

    if (connection === "open") {
      setQrCode(null);
      setEstadoConexao('conectado');
      tentativasReconexao = 0;
      console.log("✅ Bot do WhatsApp conectado com sucesso!");
    }
  });

  const idsProcessados = new Set<string>();

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const sender = msg.key.remoteJid;
      if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast") continue;

      if (msg.key.id) {
        if (idsProcessados.has(msg.key.id)) {
          console.log(`⏭️ Ignorando duplicada (id ${msg.key.id})`);
          continue;
        }
        idsProcessados.add(msg.key.id);
        if (idsProcessados.size > 500) {
          const primeiros = [...idsProcessados].slice(0, 200);
          for (const id of primeiros) idsProcessados.delete(id);
        }
      }

      const anterior = filas.get(sender) ?? Promise.resolve();
      const atual = anterior
        .then(() => tratarMensagem(sock, msg, sender))
        .catch((err) => console.error("❌ Erro no handler:", err));
      filas.set(sender, atual);
      atual.finally(() => { if (filas.get(sender) === atual) filas.delete(sender); });
    }
  });
}

// Canal WhatsApp para o atendimento: estado em memória + banco, envio pelo socket.
function canalWhatsApp(sock: Sock, sender: string): Canal {
  return {
    sessaoLog: hashSender(sender),
    carregar: async () => (await obterOuCriarEstado(sender)).estado,
    salvar: (estado) => persistir(sender, estado),
    apagar: async () => {
      if (sqlCliente) await apagarEstado(sqlCliente, sender);
      sessions.delete(sender);
    },
    enviar: (m: Mensagem) => responder(sock, sender, m.texto, m.fala),
    digitando: () => iniciarDigitando(sock, sender),
    local: "📎 → Localização",
    localDestaque: "📎 → *Localização*",
    boasVindasNaPrimeira: true,
  };
}

async function tratarMensagem(sock: Sock, msg: any, sender: string): Promise<void> {
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    "";
  const cleanText = String(text).trim();

  expirarSessaoSeVelha(sender);
  const canal = canalWhatsApp(sock, sender);

  // ── LOCALIZAÇÃO (pino do WhatsApp) ──
  const location = msg.message.locationMessage;
  if (location) {
    await atenderLocalizacao(canal, location.degreesLatitude, location.degreesLongitude);
    return;
  }

  // ── ÁUDIO → baixa aqui; a transcrição e o resto ficam no atendimento ──
  const audioMessage = msg.message.audioMessage;
  if (audioMessage) {
    await atenderAudio(canal, async () => {
      const buffer = (await Promise.race([
        downloadMediaMessage(
          msg, "buffer", {},
          { logger: pino({ level: "silent" }) as any, reuploadRequest: sock.updateMediaMessage },
        ),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('timeout download')), 15000),
        ),
      ])) as Buffer;
      return { buffer, mime: audioMessage.mimetype || "audio/ogg; codecs=opus" };
    });
    return;
  }

  // ── FOTO / STICKER / DOCUMENTO ──
  const temImagem = msg.message.imageMessage || msg.message.stickerMessage || msg.message.documentMessage;
  if (temImagem && !cleanText) {
    inc('total_fotos_sem_legenda');
    await sock.sendMessage(sender, { text: mensagemPorId("foto_sem_legenda_001").texto });
    return;
  }

  if (!cleanText) return;
  await atenderTexto(canal, cleanText, false);
}
