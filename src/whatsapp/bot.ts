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
import { mensagemPorId } from "../ia/mensagens.js";
import { reformularPergunta } from "../ia/reformulador_pergunta.js";
import type { EstadoConversa } from "../ia/tipos.js";
import {
  buscarUnidades, formatarUnidades, type TipoUsuario,
} from "../servicos/geolocalizacao.js";
import { buscarCoordenadasPorTexto } from "../servicos/nominatim.js";
import { setQrCode } from "../index.js";
import {
  criarClienteDb, baixarSessaoParaDisco, iniciarSyncPeriodico, registrarSyncNoShutdown, type Sql,
} from "./persistencia_sessao.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const sessions = new Map<string, EstadoConversa>();

// Conversas antigas não podem contaminar um caso novo (o relato acumula sinais de gravidade).
const ultimaAtividade = new Map<string, number>();
const TTL_SESSAO_MS = 6 * 60 * 60 * 1000;
const LOCALIZACAO_VALIDA_MS = 30 * 60 * 1000;

// Uma mensagem por vez por pessoa: evita corrida de estado quando ela manda várias seguidas.
const filas = new Map<string, Promise<void>>();

function expirarSessaoSeVelha(sender: string): void {
  const ultima = ultimaAtividade.get(sender);
  if (ultima && Date.now() - ultima > TTL_SESSAO_MS) sessions.delete(sender);
  ultimaAtividade.set(sender, Date.now());
}
const AUTH_DIR = "auth_info_baileys";

// ────────────────────────────────────────────────────────────
// [FIX] Guarda contra dupla inicialização
// ────────────────────────────────────────────────────────────
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

  // [FIX] Pergunta de FAQ / institucional NÃO é pedido de localização
  if (/\b(dif[a-z]{3,}|o que e|o que sao|para que serve|como funciona|quando ir|quando devo ir|quando procurar)\b/.test(n)) {
    return null;
  }

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

// UPA e UBS são femininas; "hospital" é masculino.
function artigoUnidade(tipo: 'UPA' | 'HOSPITAL' | 'UBS'): { art: string; prox: string; nome: string } {
  if (tipo === 'HOSPITAL') return { art: 'o', prox: 'próximo', nome: 'hospital' };
  return { art: 'a', prox: 'próxima', nome: tipo };
}

type Sock = ReturnType<typeof makeWASocket>;

// Único ponto que faz a busca e responde (usado por GPS, texto e localização guardada).
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
    console.log(`🔍 Buscando ${tipo} para (${lat}, ${lng})`);
    const r = await buscarUnidades(lat, lng, tipo);
    console.log(`📦 ${r.unidades.length} unidades (origem: ${r.origem}, falhaServico: ${r.falhaServico})`);
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
// [FIX] Backoff + referência única ao socket
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// START
// ────────────────────────────────────────────────────────────
export async function startWhatsAppBot(): Promise<void> {
  // [FIX] Se já tem socket ativo, não cria outro
  if (socketAtual) {
    console.warn('⚠️ Já existe um socket ativo. Ignorando chamada duplicada.');
    return;
  }

  // [FIX] Cliente Postgres criado UMA vez, reaproveitado entre reconexões
  if (!sqlCliente) {
    sqlCliente = await criarClienteDb();
  }
  const sql = sqlCliente;

  // [FIX] Baixa a sessão do banco apenas na primeira vez
  if (!botIniciado) {
    await baixarSessaoParaDisco(sql);
  }

  // [FIX] Sync periódico iniciado UMA vez
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

      // [FIX] Descarta a referência deste socket para não bloquear a próxima tentativa
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

  // ──────────────────────────────────────────────────────────
  // [FIX] Deduplica mensagens por msg.key.id — o Baileys pode reenviar em retry
  // ──────────────────────────────────────────────────────────
  const idsProcessados = new Set<string>();

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const sender = msg.key.remoteJid;
      if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast") continue;

      // [FIX] Ignora se já processou esse id
      if (msg.key.id) {
        if (idsProcessados.has(msg.key.id)) {
          console.log(`⏭️ Ignorando mensagem duplicada (id ${msg.key.id})`);
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
        .catch((err) => console.error("❌ Erro no handler de mensagem:", err));
      filas.set(sender, atual);
      atual.finally(() => { if (filas.get(sender) === atual) filas.delete(sender); });
    }
  });
}

// ────────────────────────────────────────────────────────────
// TRATAMENTO DE UMA MENSAGEM
// ────────────────────────────────────────────────────────────
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

// Reformula perguntas de acompanhamento para soar natural (desligue com REFORMULAR_PERGUNTAS=0).
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

  // ── LOCALIZAÇÃO (GPS) ──
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

    // Mandou a localização sem ninguém pedir: guarda e pergunta o que ela quer achar.
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
    try {
      await sock.sendPresenceUpdate("composing", sender);
      // [FIX Bloco 1] Feedback imediato — transcrição+TTS pode levar >15s.
      // Sem isso o usuário acha que o bot travou e manda de novo.
      await sock.sendMessage(sender, { text: "🎤 Um instante, estou ouvindo..." });

      const buffer = (await downloadMediaMessage(
        msg, "buffer", {},
        { logger: pino({ level: "silent" }) as any, reuploadRequest: sock.updateMediaMessage },
      )) as Buffer;
      if (!buffer || buffer.length === 0) throw new Error("Buffer de áudio vazio");

      const mime = audioMessage.mimetype || "audio/ogg; codecs=opus";
      console.log(`🎤 [${sender}] Áudio recebido (${(buffer.length / 1024).toFixed(1)} KB)`);

      const relatoDoAudio = await interpretarAudio(buffer, mime);

      const primeiraMensagemAudio = !sessions.has(sender);
      if (primeiraMensagemAudio) {
        sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
      }
      const estadoAtualAudio = sessions.get(sender)!;

      // A TRANSCRIÇÃO precisa chegar ao orquestrador (regras por frase, bloqueio de
      // remédio/diagnóstico e FAQ dependem do texto).
      const transcricao = (relatoDoAudio.texto_original_acumulado || "").replace(/^\[áudio\]\s*/i, "").trim();
      const textoRepresentativo = transcricao || "[áudio]";

      const { resultado, estado: novoEstado } = await processarTurnoComRelato(
        textoRepresentativo, relatoDoAudio, estadoAtualAudio,
      );
      sessions.set(sender, novoEstado);

      let respostaAudio = resultado.texto;
      if (resultado.tipo === "perguntas") {
        respostaAudio = await comTomNatural(resultado.texto, novoEstado.texto_original_acumulado);
      }
      if (primeiraMensagemAudio) {
        respostaAudio = `${MENSAGEM_BOAS_VINDAS}\n\n---\n\n${respostaAudio}`;
      }
      respostaAudio = oferecerLocalizacao(sender, resultado, respostaAudio);

      await sock.sendMessage(sender, { text: respostaAudio });
    } catch (err) {
      console.error("❌ Erro ao processar áudio:", err);
      await sock.sendMessage(sender, {
        text: "🎤 Não consegui entender esse áudio. Pode repetir ou escrever? Em emergência, ligue 192.",
      });
    }
    await sock.sendPresenceUpdate("paused", sender);
    return;
  }

  // ── FOTO / STICKER / DOCUMENTO SEM LEGENDA ──
  const temImagem = msg.message.imageMessage || msg.message.stickerMessage || msg.message.documentMessage;
  if (temImagem && !cleanText) {
    await sock.sendMessage(sender, { text: mensagemPorId("foto_sem_legenda_001").texto });
    return;
  }

  if (!cleanText) return;

  console.log(`\n📩 [${sender}] ${cleanText}`);
  const textoLimpo = cleanText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // ── RESET ──
  if (comandosReset.some((cmd) => textoLimpo === cmd.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) {
    sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
    await sock.sendMessage(sender, { text: `🔄 Reiniciado.\n\n${MENSAGEM_BOAS_VINDAS}` });
    return;
  }

  // ── FLUXO DE LOCALIZAÇÃO POR TEXTO ──
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
      // Já mandou a localização há pouco? Não pede de novo.
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

    // Digitou um endereço/bairro direto (não precisa dizer "sim" antes, nem ter 2+ palavras).
    if (pareceLocal(textoLimpo)) {
      await sock.sendPresenceUpdate("composing", sender);
      const coords = await buscarCoordenadasPorTexto(cleanText);
      if (coords) {
        await executarBusca(sock, sender, estadoLoc, coords.lat, coords.lng, tipo);
      } else {
        estadoLoc.aguardandoLocalizacao.aguardandoTexto = true;
        sessions.set(sender, estadoLoc);
        await sock.sendMessage(sender, {
          text: "Não consegui localizar esse endereço. Tente *bairro + cidade* (ex: \"Icaraí, Niterói\") ou compartilhe pelo 📎 → Localização.",
        });
      }
      return;
    }

    // Falou de sintoma ou de outro assunto: abandona a busca e segue o atendimento.
    estadoLoc.aguardandoLocalizacao = undefined;
    sessions.set(sender, estadoLoc);
  }

  // ── PEDIDO EXPLÍCITO DE LOCALIZAÇÃO ("qual a UPA mais próxima", "UPA", "hospital"...) ──
  const estadoAtual = sessions.get(sender);
  const locGuardada = estadoAtual?.ultimaLocalizacao && Date.now() - estadoAtual.ultimaLocalizacao.em < LOCALIZACAO_VALIDA_MS
    ? estadoAtual.ultimaLocalizacao : null;

  // Depois de mandar o GPS sem contexto, "upa" / "ubs" / "hospital" sozinho já basta.
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

  // ── TRIAGEM (texto) ──
  await sock.sendPresenceUpdate("composing", sender);

  const primeiraMensagem = !sessions.has(sender);
  if (primeiraMensagem) {
    sessions.set(sender, JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa);
  }

  const estadoAtualProcesso = sessions.get(sender)!;
  const { resultado, estado: novoEstado } = await processarTurno(cleanText, estadoAtualProcesso);
  // processarTurno devolve estados novos que perdem a localização guardada; preserva.
  if (estadoAtualProcesso.ultimaLocalizacao && !novoEstado.ultimaLocalizacao) {
    novoEstado.ultimaLocalizacao = estadoAtualProcesso.ultimaLocalizacao;
  }
  sessions.set(sender, novoEstado);

  let mensagemFinal = resultado.texto;

  // Perguntas de acompanhamento em tom natural (Gemini, com timeout e fallback para a original).
  const perguntaGenericaDuplicada = primeiraMensagem && resultado.tipo === "perguntas" && resultado.tema === "vago";
  if (resultado.tipo === "perguntas" && !perguntaGenericaDuplicada) {
    mensagemFinal = await comTomNatural(resultado.texto, novoEstado.texto_original_acumulado);
  }

  if (primeiraMensagem) {
    const privacidade = mensagemPorId("privacidade_001").texto;
    // A boas-vindas já termina perguntando o que a pessoa sente; não repete a pergunta genérica.
    mensagemFinal = perguntaGenericaDuplicada
      ? `${MENSAGEM_BOAS_VINDAS}\n\n${privacidade}`
      : `${MENSAGEM_BOAS_VINDAS}\n\n${privacidade}\n\n---\n\n${mensagemFinal}`;
  }

  mensagemFinal = oferecerLocalizacao(sender, resultado, mensagemFinal);

  await sock.sendMessage(sender, { text: mensagemFinal });
  await sock.sendPresenceUpdate("paused", sender);
}

// [FIX] NÃO chama startWhatsAppBot() aqui. O index.ts é quem chama.