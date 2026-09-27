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
import { transcreverAudio } from "../servicos/transcricao_audio.js";
import { processarTurno, ESTADO_INICIAL } from "../ia/orquestrador.js";
import { mensagemPorId } from "../ia/mensagens.js";
import { escolherAleatorio, RESETS } from "../ia/variacao.js";
import type { EstadoConversa } from "../ia/tipos.js";
import {
  buscarUnidades, formatarUnidades, type TipoUsuario,
} from "../servicos/geolocalizacao.js";
import { buscarCoordenadasPorTexto } from "../servicos/nominatim.js";
import { textoParaAudio } from "../servicos/texto_para_audio.js";
import { inc } from "../servicos/metricas.js";
import { setQrCode } from "../servicos/qr.js";
import {
  criarClienteDb, baixarSessaoParaDisco, iniciarSyncPeriodico, registrarSyncNoShutdown, type Sql,
} from "./persistencia_sessao.js";
import {
  salvarEstado, carregarEstado, apagarEstado,
} from "./persistencia_estado.js";

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000';

const sessions = new Map<string, EstadoConversa>();

const ultimaAtividade = new Map<string, number>();
const TTL_SESSAO_MS = 6 * 60 * 60 * 1000;
const LOCALIZACAO_VALIDA_MS = 30 * 60 * 1000;

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

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + custo);
    }
  }
  return dp[m][n];
}

function semAcento(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.!]+$/, "").trim();
}

// Tolerância a erro de digitação SÓ em comandos com "/" ou frases longas.
// Palavras curtas ("menu", "inicio") precisam ser exatas: com tolerância,
// respostas como "mes", "meu", "medo" e "meio" reiniciavam a triagem.
export function ehComandoReset(entrada: string): boolean {
  const norm = semAcento(entrada);
  if (norm.startsWith('/')) {
    return levenshtein(norm, '/reset') <= 1 || levenshtein(norm, '/start') <= 1 || norm === '/reiniciar';
  }
  for (const cmd of comandosReset) {
    const alvo = semAcento(cmd);
    if (norm === alvo) return true;
    if (alvo.length >= 10 && levenshtein(norm, alvo) <= 2) return true;
  }
  return false;
}

function ehComandoApagar(entrada: string): boolean {
  const n = entrada.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return /^\/?(apagar|excluir)( meus? (dados|historico|conversa))?$/.test(n)
    || /^(apagar|excluir) (meus? )?(dados|historico|conversa)$/.test(n);
}

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

function detectarPedidoLocalizacao(texto: string): 'UPA' | 'HOSPITAL' | 'UBS' | null {
  const n = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
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

async function executarBusca(
  sock: Sock, sender: string, estado: EstadoConversa,
  lat: number, lng: number, tipo: TipoUsuario,
): Promise<void> {
  estado.ultimaLocalizacao = { lat, lng, em: Date.now() };
  estado.aguardandoLocalizacao = undefined;
  await persistir(sender, estado);

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

const LOCAL_POR_RESPOSTA: Record<string, 'UPA' | 'HOSPITAL' | 'UBS'> = {
  upa_001: 'UPA', dengue_001: 'UPA', desidratacao_001: 'UPA', intoxicacao_001: 'UPA',
  emergencia_001: 'HOSPITAL', obstetricia_001: 'HOSPITAL', pediatria_emergencia_001: 'HOSPITAL',
  mental_emergencia_001: 'HOSPITAL', violencia_001: 'HOSPITAL',
  ubs_001: 'UBS',
};

// Anexa a oferta de "unidade mais próxima" e marca no estado que estamos aguardando a localização.
function oferecerLocalizacao(
  estado: EstadoConversa,
  resultado: { tipo: string; decisao?: { resposta_id: string } },
  mensagemBase: string,
): string {
  if (resultado.tipo !== 'orientacao' || !resultado.decisao) return mensagemBase;
  const tipoLocalizacao = LOCAL_POR_RESPOSTA[resultado.decisao.resposta_id];
  if (!tipoLocalizacao) return mensagemBase;

  const { art, prox, nome } = artigoUnidade(tipoLocalizacao);
  const texto =
    mensagemBase +
    `\n\n📍 *Quer saber ${art} ${nome} mais ${prox}?* 🙋\n` +
    `Responda *"sim"* e me mande sua localização (📎 → Localização) ou escreva seu *bairro e cidade*.`;

  estado.aguardandoLocalizacao = { ativo: true, tipo: tipoLocalizacao, mensagemOriginal: texto };
  return texto;
}

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
  registrarClienteDb(sql);

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
      console.log(`👉 Abra no navegador: ${PUBLIC_URL}/qr`);
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

async function tratarMensagem(sock: Sock, msg: any, sender: string): Promise<void> {
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    "";
  const cleanText = String(text).trim();

  expirarSessaoSeVelha(sender);

  // ── LOCALIZAÇÃO (pino do WhatsApp) ──
  const location = msg.message.locationMessage;
  if (location) {
    const lat = location.degreesLatitude;
    const lng = location.degreesLongitude;
    if (lat == null || lng == null) {
      await sock.sendMessage(sender, { text: "📍 Localização inválida. Tente novamente." });
      return;
    }

    const { estado } = await obterOuCriarEstado(sender);
    const aguardando = estado.aguardandoLocalizacao;
    if (aguardando?.ativo) {
      await executarBusca(sock, sender, estado, lat, lng, aguardando.tipo);
      return;
    }

    estado.ultimaLocalizacao = { lat, lng, em: Date.now() };
    await persistir(sender, estado);
    await sock.sendMessage(sender, {
      text: "📍 Localização recebida! O que você quer encontrar perto de você?\n\nResponda: *UPA*, *UBS* ou *hospital*.",
    });
    return;
  }

  // ── ÁUDIO → transcreve e segue EXATAMENTE o mesmo caminho do texto ──
  const audioMessage = msg.message.audioMessage;
  if (audioMessage) {
    inc('total_audios');
    const pararDigitandoAudio = iniciarDigitando(sock, sender);
    let transcricao = '';
    try {
      await sock.sendMessage(sender, { text: "🎤 Um instante, estou ouvindo..." });

      const buffer = (await Promise.race([
        downloadMediaMessage(
          msg, "buffer", {},
          { logger: pino({ level: "silent" }) as any, reuploadRequest: sock.updateMediaMessage },
        ),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('timeout download')), 15000),
        ),
      ])) as Buffer;
      if (!buffer || buffer.length === 0) throw new Error("Buffer vazio");

      const mime = audioMessage.mimetype || "audio/ogg; codecs=opus";
      console.log(`🎤 [${hashSender(sender)}] Áudio (${(buffer.length / 1024).toFixed(1)} KB)`);

      transcricao = await transcreverAudio(buffer, mime);
      if (!transcricao || transcricao.length < 3) {
        await new Promise((r) => setTimeout(r, 500));
        transcricao = await transcreverAudio(buffer, mime);
      }
    } catch (err) {
      console.error("❌ Erro ao baixar/transcrever áudio:", err);
    }
    pararDigitandoAudio();

    if (!transcricao || transcricao.length < 3) {
      await sock.sendMessage(sender, {
        text:
          '🎤 Não consegui entender o áudio. Pode repetir em um lugar mais silencioso ou escrever? ' +
          'Em emergência, ligue 192.',
      });
      return;
    }
    await processarTexto(sock, sender, transcricao, true);
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
  await processarTexto(sock, sender, cleanText, false);
}

async function processarTexto(sock: Sock, sender: string, cleanText: string, veioDeAudio: boolean): Promise<void> {
  console.log(`\n📩 [${hashSender(sender)}]${veioDeAudio ? ' (áudio)' : ''} ${cleanText.slice(0, 40)}${cleanText.length > 40 ? '...' : ''}`);
  const textoLimpo = cleanText.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const prefixoAudio = veioDeAudio ? `_🎤 Ouvi: "${cleanText}"_\n\n` : '';

  // ── APAGAR DADOS (LGPD) ──
  if (ehComandoApagar(cleanText)) {
    try {
      if (sqlCliente) await apagarEstado(sqlCliente, sender);
      sessions.delete(sender);
      await sock.sendMessage(sender, {
        text:
          '🗑️ *Seus dados foram apagados.*\n\n' +
          'Removi o histórico desta conversa e o estado associado ao seu número. ' +
          'Se quiser recomeçar do zero, mande qualquer mensagem.',
      });
    } catch (err) {
      console.error('❌ Erro ao apagar dados:', err);
      await sock.sendMessage(sender, {
        text: '⚠️ Não consegui apagar agora. Tente de novo em alguns minutos ou mande /reset para limpar a conversa local.',
      });
    }
    return;
  }

  // ── RESET ──
  if (ehComandoReset(cleanText)) {
    const estadoReset = JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa;
    estadoReset.historico = [
      { role: 'user', content: '/reset', ts: Date.now() },
      { role: 'assistant', content: '🔄 Reiniciado.', ts: Date.now() },
    ];
    await persistir(sender, estadoReset);
    await sock.sendMessage(sender, { text: escolherAleatorio(RESETS) });
    return;
  }

  // ── LOCALIZAÇÃO POR TEXTO (depois de oferecermos a busca) ──
  const { estado: estadoLoc } = await obterOuCriarEstado(sender);
  if (estadoLoc.aguardandoLocalizacao?.ativo) {
    const decisao = matchSimNao(textoLimpo);
    const palavras = textoLimpo.split(/\s+/).filter(Boolean);
    const temPalavraClinica = CLINICA_RE.test(textoLimpo);
    const tipo = estadoLoc.aguardandoLocalizacao.tipo;
    const locRecente = estadoLoc.ultimaLocalizacao && Date.now() - estadoLoc.ultimaLocalizacao.em < LOCALIZACAO_VALIDA_MS
      ? estadoLoc.ultimaLocalizacao : null;

    if (decisao === "nao" && palavras.length <= 4 && !temPalavraClinica) {
      estadoLoc.aguardandoLocalizacao = undefined;
      await persistir(sender, estadoLoc);
      await sock.sendMessage(sender, { text: "Tudo bem! Se precisar, é só me chamar. 💙" });
      return;
    }

    if (decisao === "sim" && palavras.length <= 4 && !temPalavraClinica) {
      if (locRecente) {
        await executarBusca(sock, sender, estadoLoc, locRecente.lat, locRecente.lng, tipo);
        return;
      }
      estadoLoc.aguardandoLocalizacao.aguardandoTexto = true;
      await persistir(sender, estadoLoc);
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
        inc('nominatim_falha');
        estadoLoc.aguardandoLocalizacao.aguardandoTexto = true;
        await persistir(sender, estadoLoc);
        await sock.sendMessage(sender, {
          text: "Não consegui localizar esse endereço. Tente *bairro + cidade* ou compartilhe pelo 📎 → Localização.",
        });
      }
      return;
    }

    // Não era resposta sobre localização → segue para a triagem.
    estadoLoc.aguardandoLocalizacao = undefined;
  }

  // ── PEDIDO EXPLÍCITO DE LOCALIZAÇÃO ("onde tem uma UPA?") ──
  const locGuardada = estadoLoc.ultimaLocalizacao && Date.now() - estadoLoc.ultimaLocalizacao.em < LOCALIZACAO_VALIDA_MS
    ? estadoLoc.ultimaLocalizacao : null;

  let pedidoLoc = detectarPedidoLocalizacao(cleanText);
  if (!pedidoLoc && locGuardada) {
    if (/^(a |o )?(upa|pronto socorro|pronto atendimento)$/.test(textoLimpo)) pedidoLoc = "UPA";
    else if (/^(a |o )?(ubs|posto( de saude)?|clinica da familia)$/.test(textoLimpo)) pedidoLoc = "UBS";
    else if (/^(o |um )?hospital$/.test(textoLimpo)) pedidoLoc = "HOSPITAL";
  }

  if (pedidoLoc) {
    if (locGuardada) {
      await executarBusca(sock, sender, estadoLoc, locGuardada.lat, locGuardada.lng, pedidoLoc);
      return;
    }
    estadoLoc.aguardandoLocalizacao = { ativo: true, tipo: pedidoLoc, mensagemOriginal: cleanText, aguardandoTexto: true };
    await persistir(sender, estadoLoc);
    const { art, prox, nome } = artigoUnidade(pedidoLoc);
    await sock.sendMessage(sender, {
      text: `${prefixoAudio}📍 Compartilhe sua localização (📎 → Localização) ou escreva seu *bairro e cidade* que eu busco ${art} ${nome} mais ${prox}.`,
    });
    return;
  }

  // ── TRIAGEM (guarda → LLM decisor → validação) ──
  const pararDigitando = iniciarDigitando(sock, sender);
  try {
    const primeiraMensagem = (estadoLoc.historico?.length ?? 0) === 0;

    const { resultado, estado: novoEstado } = await processarTurno(cleanText, estadoLoc, {
      origem: veioDeAudio ? 'audio' : 'texto',
      sessao: hashSender(sender),
    });
    if (estadoLoc.ultimaLocalizacao && !novoEstado.ultimaLocalizacao) {
      novoEstado.ultimaLocalizacao = estadoLoc.ultimaLocalizacao;
    }

    let mensagemFinal = resultado.texto;
    if (primeiraMensagem) {
      const boasVindas = `${MENSAGEM_BOAS_VINDAS}\n\n${mensagemPorId("privacidade_001").texto}`;
      // Saudação na 1ª mensagem: as boas-vindas já pedem o relato — não duplica a pergunta.
      mensagemFinal = resultado.acao === 'conversa' ? boasVindas : `${boasVindas}\n\n---\n\n${mensagemFinal}`;
    }
    mensagemFinal = oferecerLocalizacao(novoEstado, resultado, mensagemFinal);

    await persistir(sender, novoEstado);
    pararDigitando();
    await responder(sock, sender, `${prefixoAudio}${mensagemFinal}`, veioDeAudio);
  } catch (err) {
    pararDigitando();
    throw err;
  }
}
