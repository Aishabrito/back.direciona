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
import { createHash } from "crypto";

import { processarTurno, processarTurnoComRelato, ESTADO_INICIAL } from "../ia/orquestrador.js";
import { interpretarAudio } from "../ia/extrator_de_informacoes.js";
import { mensagemPorId } from "../ia/mensagens.js";
import { reformularPergunta } from "../ia/reformulador_pergunta.js";
import type { EstadoConversa } from "../ia/tipos.js";
import {
  buscarUnidades, formatarUnidades, type TipoUsuario,
} from "../servicos/geolocalizacao.js";
import { buscarCoordenadasPorTexto } from "../servicos/nominatim.js";
import { textoParaAudio } from "../servicos/texto_para_audio.js";
import { inc } from "../servicos/metricas.js";
import { setQrCode } from "../index.js";
import {
  criarClienteDb, baixarSessaoParaDisco, iniciarSyncPeriodico, registrarSyncNoShutdown, type Sql,
} from "./persistencia_sessao.js";
import {
  salvarEstado, carregarEstado, apagarEstado,
} from "./persistencia_estado.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const sessions = new Map<string, EstadoConversa>();

const ultimaAtividade = new Map<string, number>();
const TTL_SESSAO_MS = 6 * 60 * 60 * 1000;
const LOCALIZACAO_VALIDA_MS = 30 * 60 * 1000;

const filas = new Map<string, Promise<void>>();

// [Bloco 2] Rate limit do Gemini por usuário (30 chamadas/hora)
const contadorGemini = new Map<string, number>();
const LIMITE_GEMINI_POR_HORA = 30;

function podeChamarGemini(sender: string): boolean {
  const janela = Math.floor(Date.now() / 3600000);
  const chave = `${sender}|${janela}`;
  const atual = contadorGemini.get(chave) ?? 0;
  if (atual >= LIMITE_GEMINI_POR_HORA) return false;
  contadorGemini.set(chave, atual + 1);

  if (contadorGemini.size > 5000) {
    const janelaAtual = janela;
    for (const k of contadorGemini.keys()) {
      if (!k.endsWith(`|${janelaAtual}`)) contadorGemini.delete(k);
    }
  }
  return true;
}

// [Bloco 2] LGPD: hash do remetente para logs
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

function detectarPedidoLocalizacao(texto: string): 'UPA' | 'HOSPITAL' | 'UBS' | null {
  const n = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\b(dif[a-z]{3,}|o que e|o que sao|para que serve|como funciona|quando ir|quando devo ir|quando procurar)\b/.test(n)) return null;

  const temVerboLocal =
    /\b(onde (tem|fica|e|eh|esta)|me manda|me passa|me indica|qual (a|o) (upa|ubs|hospital|posto)|qual (upa|ubs|hospital)|quero (ir|saber)|preciso (ir|saber)|tem (uma|um|algum)|existe (uma|um|algum))\b/.test(n);
  if (!temVerboLocal) return null;

  if (/\b(upa|pronto\s*socorro|pronto-socorro|emergencia)\b/.test(n)) return 'UPA';
  if (/\b(hospital|hospitalar)\b/.test(n)) return 'HOSPITAL';
  if (/\b(ubs|posto\s*de\s*saude|posto|clinica|clinica\s*da\s*familia)\b/.test(n)) return 'UBS';
  return null;
}

function matchSimNao(textoLimpo: string): "sim" | "nao" | null {
  const norm = textoLimpo.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const [primeira = "", segunda = ""] = norm.split(" ");
  if (/^(nao|n|dispensa|depois)$/.test(primeira)) return "nao";
  if (primeira === "por") return segunda === "favor" ? "sim" : null;
  if (/^(sim|s|quero|ok|claro|bora|manda|pode|vamos|aceito|pfv|pf)$/.test(primeira)) return "sim";
  return null;
}

function artigoUnidade(tipo: 'UPA' | 'HOSPITAL' | 'UBS'): { art: string; prox: string; nome: string } {
  if (tipo === 'HOSPITAL') return { art: 'o', prox: 'próximo', nome: 'hospital' };
  return { art: 'a', prox: 'próxima', nome: tipo };
}

type Sock = ReturnType<typeof makeWASocket>;

async function executarBusca(
  sock: Sock, sender: string, estado: EstadoConversa,
  lat: number, lng: number, tipo: TipoUsuario,
): Promise<void> {
  estado.ultimaLocalizacao = { lat, lng, em: Date.now() };
  estado.aguardandoLocalizacao = undefined;
  sessions.set(sender, estado);

  await sock.sendMessage(sender, { text: "🔎 Buscando as unidades mais próximas, um instante..." });
  await sock.sendPresenceUpdate("composing", sender);
  try {
    console.log(`🔍 [${hashSender(sender)}] Buscando ${tipo}`);
    const r = await buscarUnidades(lat, lng, tipo);
    console.log(`📦 [${hashSender(sender)}] ${r.unidades.length} unidades (origem: ${r.origem})`);
    await sock.sendMessage(sender, {
      text: formatarUnidades(r.unidades, lat, lng, tipo, { falhaServico: r.falhaServico }),
    });
  } catch (err) {
    console.error("❌ Erro ao buscar unidades:", err);
    await sock.sendMessage(sender, {
      text: "❌ Erro ao buscar unidades próximas. Se for emergência, ligue 192 agora.",
    });
  }
  await sock.sendPresenceUpdate("paused", sender);
}

function oferecerLocalizacao(
  sender: string,
  resultado: { tipo: string; decisao?: { resposta_id: string } },
  mensagemBase: string,
): string {
  if (resultado.tipo !== 'orientacao' || !resultado.decisao) return mensagemBase;

  const respostaId = resultado.decisao.resposta_id;
  let tipoLocalizacao: 'UPA' | 'HOSPITAL' | 'UBS' | null = null;

  if (respostaId === 'upa_001') tipoLocalizacao = 'UPA';
  else if (['emergencia_001','obstetricia_001','pediatria_emergencia_001','mental_emergencia_001','violencia_001'].includes(respostaId))
    tipoLocalizacao = 'HOSPITAL';
  else if (respostaId === 'ubs_001') tipoLocalizacao = 'UBS';

  if (!tipoLocalizacao) return mensagemBase;

  const { art, prox, nome } = artigoUnidade(tipoLocalizacao);
  const texto =
    mensagemBase +
    `\n\n📍 *Quer saber ${art} ${nome} mais ${prox}?* 🙋\n` +
    `Responda *"sim"* e me mande sua localização (📎 → Localização) ou escreva seu *bairro e cidade*.`;

  const estadoApos = sessions.get(sender)!;
  estadoApos.aguardandoLocalizacao = { ativo: true, tipo: tipoLocalizacao, mensagemOriginal: texto };
  sessions.set(sender, estadoApos);
  return texto;
}

// ────────────────────────────────────────────────────────────
// Responde: se a pessoa mandou áudio, devolve áudio também.
// ────────────────────────────────────────────────────────────
async function responder(
  sock: Sock,
  sender: string,
  texto: string,
  responderComAudio: boolean,
): Promise<void> {
  if (!responderComAudio) {
    await sock.sendMessage(sender, { text: texto });
    return;
  }

  try {
    const audio = await textoParaAudio(texto, 'feminina');
    if (audio && audio.length > 0) {
      console.log(`🎤 [${hashSender(sender)}] Resposta em áudio (${(audio.length / 1024).toFixed(1)} KB)`);
      inc('gemini_tts_ok');
      await sock.sendMessage(sender, {
        audio,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });
      return;
    }
    inc('gemini_tts_erro');
  } catch (err) {
    console.error('❌ Falha ao gerar áudio:', err);
    inc('gemini_tts_erro');
  }

  await sock.sendMessage(sender, { text: texto });
}

let tentativasReconexao = 0;
const MAX_BACKOFF_MS = 60_000;
let reconexaoAgendada = false;

function agendarReconexao() {
  if (reconexaoAgendada) return;
  reconexaoAgendada = true;

  const espera = Math.min(MAX_BACKOFF_MS, 2000 * Math.pow(2, tentativasReconexao));
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

  if (!botIniciado) {
    await baixarSessaoParaDisco(sql);
  }

  if (!syncIniciado && sql) {
    iniciarSyncPeriodico(sql);
    registrarSyncNoShutdown(sql);
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
    browser: ["Direciona SUS", "Chrome", "1.0.0"],
  });

  socketAtual = sock;

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
      const permanente = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
      socketAtual = null;

      if (!permanente) {
        agendarReconexao();
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

const CLINICA_RE = /\b(dor|falta de ar|desmaio|sangramento|febre|vomito|confus|tontura|peito|respir|convuls|acidente|queimad|trauma|pior|piorou|sinto|tosse|barriga|cabeca)\b/;

const CONVERSA_RE = /^(oi|ola|obrigad[oa]|valeu|vlw|tchau|ate mais|blz|beleza|tudo bem|bom dia|boa tarde|boa noite|nao sei|talvez|hm+|kkk+)$/;
const PERGUNTA_RE = /\?|\b(qual|quais|como|quando|porque|por que|o que|onde|dif[a-z]{3,})\b/;

function pareceLocal(textoLimpo: string): boolean {
  const palavras = textoLimpo.split(/\s+/).filter(Boolean);
  return (
    palavras.length >= 1 && palavras.length <= 7 &&
    !CLINICA_RE.test(textoLimpo) && !PERGUNTA_RE.test(textoLimpo) &&
    !CONVERSA_RE.test(textoLimpo) && !matchSimNao(textoLimpo)
  );
}

async function comTomNatural(pergunta: string, contexto: string): Promise<string> {
  if (process.env.REFORMULAR_PERGUNTAS === "0") return pergunta;
  return reformularPergunta(pergunta, contexto);
}

async function tratarMensagem(sock: Sock, msg: any, sender: string): Promise<void> {
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    "";
  const cleanText = String(text).trim();

  expirarSessaoSeVelha(sender);

  // ── LOCALIZAÇÃO ──
  const location = msg.message.locationMessage;
  if (location) {
    const lat = location.degreesLatitude;
    const lng = location.degreesLongitude;
    if (lat == null || lng == null) {
      await sock.sendMessage(sender, { text: "📍 Localização inválida. Tente novamente." });
      return;
    }

    const estado = sessions.get(sender) ?? (JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
    const aguardando = estado.aguardandoLocalizacao;
    if (aguardando?.ativo) {
      await executarBusca(sock, sender, estado, lat, lng, aguardando.tipo);
      return;
    }

    estado.ultimaLocalizacao = { lat, lng, em: Date.now() };
    sessions.set(sender, estado);
    await sock.sendMessage(sender, {
      text: "📍 Localização recebida! O que você quer encontrar perto de você?\n\nResponda: *UPA*, *UBS* ou *hospital*.",
    });
    return;
  }

  // ── ÁUDIO ──
  const audioMessage = msg.message.audioMessage;
  if (audioMessage) {
    inc('total_audios');
    try {
      await sock.sendPresenceUpdate("composing", sender);
      // [Bloco 2] Aviso imediato — TTS + transcrição podem levar >15s
      await sock.sendMessage(sender, { text: "🎤 Um instante, estou ouvindo..." });

      const buffer = (await downloadMediaMessage(
        msg, "buffer", {},
        { logger: pino({ level: "silent" }) as any, reuploadRequest: sock.updateMediaMessage },
      )) as Buffer;
      if (!buffer || buffer.length === 0) throw new Error("Buffer vazio");

      const mime = audioMessage.mimetype || "audio/ogg; codecs=opus";
      console.log(`🎤 [${hashSender(sender)}] Áudio (${(buffer.length / 1024).toFixed(1)} KB)`);

      const relatoDoAudio = await interpretarAudio(buffer, mime);

      const primeiraMensagemAudio = !sessions.has(sender);
      if (primeiraMensagemAudio) {
        sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
      }
      const estadoAtualAudio = sessions.get(sender)!;

      const transcricao = (relatoDoAudio.texto_original_acumulado || "").replace(/^\[áudio\]\s*/i, "").trim();
      const textoRepresentativo = transcricao || "[áudio]";

      const { resultado, estado: novoEstado } = await processarTurnoComRelato(
        textoRepresentativo, relatoDoAudio, estadoAtualAudio,
      );
      sessions.set(sender, novoEstado);

      // [Bloco 2] Persiste estado
      if (sqlCliente) await salvarEstado(sqlCliente, sender, novoEstado);

      let respostaAudio = resultado.texto;
      if (resultado.tipo === "perguntas") {
        respostaAudio = await comTomNatural(resultado.texto, novoEstado.texto_original_acumulado);
      }
      if (primeiraMensagemAudio) {
        respostaAudio = `${MENSAGEM_BOAS_VINDAS}\n\n---\n\n${respostaAudio}`;
      }
      respostaAudio = oferecerLocalizacao(sender, resultado, respostaAudio);

      // [FIX] Responde em áudio porque a pessoa mandou áudio
      await responder(sock, sender, respostaAudio, true);
    } catch (err) {
      console.error("❌ Erro ao processar áudio:", err);
      await sock.sendMessage(sender, {
        text: "🎤 Não consegui entender esse áudio. Pode repetir ou escrever? Em emergência, ligue 192.",
      });
    }
    await sock.sendPresenceUpdate("paused", sender);
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

  console.log(`\n📩 [${hashSender(sender)}] ${cleanText.slice(0, 40)}${cleanText.length > 40 ? '...' : ''}`);
  const textoLimpo = cleanText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // ── RESET ──
  if (comandosReset.some((cmd) => textoLimpo === cmd.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) {
    sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
    if (sqlCliente) await apagarEstado(sqlCliente, sender);
    await sock.sendMessage(sender, { text: `🔄 Reiniciado.\n\n${MENSAGEM_BOAS_VINDAS}` });
    return;
  }

  // ── LOCALIZAÇÃO POR TEXTO ──
  const estadoLoc = sessions.get(sender);
  if (estadoLoc?.aguardandoLocalizacao?.ativo) {
    const decisao = matchSimNao(textoLimpo);
    const palavras = textoLimpo.split(/\s+/).filter(Boolean);
    const temPalavraClinica = CLINICA_RE.test(textoLimpo);
    const tipo = estadoLoc.aguardandoLocalizacao.tipo;
    const locRecente = estadoLoc.ultimaLocalizacao && Date.now() - estadoLoc.ultimaLocalizacao.em < LOCALIZACAO_VALIDA_MS
      ? estadoLoc.ultimaLocalizacao : null;

    if (decisao === "nao" && palavras.length <= 4 && !temPalavraClinica) {
      estadoLoc.aguardandoLocalizacao = undefined;
      sessions.set(sender, estadoLoc);
      await sock.sendMessage(sender, { text: "Tudo bem! Se precisar, é só me chamar. 💙" });
      return;
    }

    if (decisao === "sim" && palavras.length <= 4 && !temPalavraClinica) {
      if (locRecente) {
        await executarBusca(sock, sender, estadoLoc, locRecente.lat, locRecente.lng, tipo);
        return;
      }
      estadoLoc.aguardandoLocalizacao.aguardandoTexto = true;
      sessions.set(sender, estadoLoc);
      await sock.sendMessage(sender, {
        text: `📍 Me mande sua localização pelo 📎 → *Localização*.\n\nOu escreva seu *bairro e cidade* (ex: "Icaraí, Niterói") que eu busco pra você.`,
      });
      return;
    }

    if (pareceLocal(textoLimpo)) {
      await sock.sendPresenceUpdate("composing", sender);
      const coords = await buscarCoordenadasPorTexto(cleanText);
      if (coords) {
        await executarBusca(sock, sender, estadoLoc, coords.lat, coords.lng, tipo);
      } else {
        estadoLoc.aguardandoLocalizacao.aguardandoTexto = true;
        sessions.set(sender, estadoLoc);
        await sock.sendMessage(sender, {
          text: "Não consegui localizar esse endereço. Tente *bairro + cidade* ou compartilhe pelo 📎 → Localização.",
        });
      }
      return;
    }

    estadoLoc.aguardandoLocalizacao = undefined;
    sessions.set(sender, estadoLoc);
  }

  // ── PEDIDO EXPLÍCITO DE LOCALIZAÇÃO ──
  const estadoAtual = sessions.get(sender);
  const locGuardada = estadoAtual?.ultimaLocalizacao && Date.now() - estadoAtual.ultimaLocalizacao.em < LOCALIZACAO_VALIDA_MS
    ? estadoAtual.ultimaLocalizacao : null;

  let pedidoLoc = detectarPedidoLocalizacao(cleanText);
  if (!pedidoLoc && locGuardada && !estadoAtual?.aguardandoLocalizacao?.ativo) {
    if (/^(a |o )?(upa|pronto socorro|pronto atendimento)$/.test(textoLimpo)) pedidoLoc = "UPA";
    else if (/^(a |o )?(ubs|posto( de saude)?|clinica da familia)$/.test(textoLimpo)) pedidoLoc = "UBS";
    else if (/^(o |um )?hospital$/.test(textoLimpo)) pedidoLoc = "HOSPITAL";
  }

  if (pedidoLoc) {
    const estado = estadoAtual ?? (JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
    if (locGuardada) {
      await executarBusca(sock, sender, estado, locGuardada.lat, locGuardada.lng, pedidoLoc);
      return;
    }
    estado.aguardandoLocalizacao = { ativo: true, tipo: pedidoLoc, mensagemOriginal: cleanText, aguardandoTexto: true };
    sessions.set(sender, estado);
    const { art, prox, nome } = artigoUnidade(pedidoLoc);
    await sock.sendMessage(sender, {
      text: `📍 Compartilhe sua localização (📎 → Localização) ou escreva seu *bairro e cidade* que eu busco ${art} ${nome} mais ${prox}.`,
    });
    return;
  }

  // ── TRIAGEM ──
  await sock.sendPresenceUpdate("composing", sender);

  const primeiraMensagem = !sessions.has(sender);
  if (primeiraMensagem) {
    sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
  }

  const estadoAtualProcesso = sessions.get(sender)!;
  const { resultado, estado: novoEstado } = await processarTurno(cleanText, estadoAtualProcesso);
  if (estadoAtualProcesso.ultimaLocalizacao && !novoEstado.ultimaLocalizacao) {
    novoEstado.ultimaLocalizacao = estadoAtualProcesso.ultimaLocalizacao;
  }
  sessions.set(sender, novoEstado);

  // [Bloco 2] Persiste estado
  if (sqlCliente) await salvarEstado(sqlCliente, sender, novoEstado);

  let mensagemFinal = resultado.texto;

  const perguntaGenericaDuplicada = primeiraMensagem && resultado.tipo === "perguntas" && resultado.tema === "vago";
  if (resultado.tipo === "perguntas" && !perguntaGenericaDuplicada) {
    mensagemFinal = await comTomNatural(resultado.texto, novoEstado.texto_original_acumulado);
  }

  if (primeiraMensagem) {
    const privacidade = mensagemPorId("privacidade_001").texto;
    mensagemFinal = perguntaGenericaDuplicada
      ? `${MENSAGEM_BOAS_VINDAS}\n\n${privacidade}`
      : `${MENSAGEM_BOAS_VINDAS}\n\n${privacidade}\n\n---\n\n${mensagemFinal}`;
  }

  mensagemFinal = oferecerLocalizacao(sender, resultado, mensagemFinal);

  // Veio de texto → responde em texto
  await responder(sock, sender, mensagemFinal, false);
  await sock.sendPresenceUpdate("paused", sender);
}