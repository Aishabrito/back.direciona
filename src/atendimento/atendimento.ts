// Atendimento do Direciona.Ai, independente do canal.
// O WhatsApp (whatsapp/bot.ts) e o app (api/rotas.ts) chamam estas funções, então os
// dois têm exatamente o mesmo comportamento: comandos (início, apagar), boas-vindas,
// áudio, oferta e busca de unidades próximas, e a triagem (orquestrador).
import { processarTurno, ESTADO_INICIAL } from '../ia/orquestrador.js';
import { escolherAleatorio, RESETS } from '../ia/variacao.js';
import type { EstadoConversa } from '../ia/tipos.js';
import { buscarUnidades, formatarUnidades, type TipoUsuario } from '../servicos/geolocalizacao.js';
import { buscarCoordenadasPorTexto } from '../servicos/nominatim.js';
import { tipoParaOferecer, artigoUnidade } from '../servicos/oferta_localizacao.js';
import { transcreverAudio } from '../servicos/transcricao_audio.js';
import { inc } from '../servicos/metricas.js';

/** Uma mensagem para a pessoa. `fala` = texto a virar áudio (só quando ela mandou áudio). */
export type Mensagem = { texto: string; fala?: string };

/** O que muda de um canal para outro. */
export interface Canal {
  /** id anônimo para os logs (hash do número, id da sessão do app...) */
  sessaoLog: string;
  carregar(): Promise<EstadoConversa | null>;
  salvar(estado: EstadoConversa): Promise<void>;
  apagar(): Promise<void>;
  /** Envia na hora (o WhatsApp manda "🔎 Buscando..." antes da busca demorar). */
  enviar(m: Mensagem): Promise<void>;
  /** Mostra "digitando..." enquanto o bot pensa; devolve a função que para. */
  digitando?(): () => void;
  /** Como compartilhar a localização neste canal, ex.: "📎 → Localização". */
  local: string;
  /** O mesmo, com destaque, ex.: "📎 → *Localização*". */
  localDestaque: string;
  /** Mandar a apresentação completa na 1ª mensagem (o app já mostra ao abrir o chat). */
  boasVindasNaPrimeira: boolean;
}

const LOCALIZACAO_VALIDA_MS = 30 * 60 * 1000;

// Primeira mensagem: explica o que é o Direciona.Ai. Depois disso, respostas curtas.
export const MENSAGEM_BOAS_VINDAS =
  "👋 Olá! Eu sou o *Direciona.Ai*, um assistente virtual *gratuito* que ajuda você a saber " +
  "*onde buscar atendimento no SUS* — sem precisar adivinhar se é caso de posto, UPA ou SAMU.\n\n" +
  "*Como funciona:*\n" +
  "1️⃣ Você me conta o que está sentindo (pode ser por *texto ou áudio* 🎤)\n" +
  "2️⃣ Eu faço algumas perguntas rápidas\n" +
  "3️⃣ Te digo qual serviço procurar — *UBS, UPA, Pronto-Socorro ou SAMU 192* — e posso mostrar o mais perto de você 📍\n\n" +
  "Também tiro dúvidas sobre saúde e sobre o SUS (ex.: _\"qual a diferença entre UBS e UPA?\"_).\n\n" +
  "⚠️ Eu *não dou diagnóstico nem receito remédio*. Em emergência, ligue *192* na hora.\n" +
  "🔒 Não envie CPF, endereço completo ou dados de cartão. Para apagar seus dados, mande *apagar*.\n" +
  "↩️ Para recomeçar a qualquer momento, mande *início*.";

const CONVITE_RELATO = "Me conta: *o que está acontecendo ou o que você está sentindo?*";

// Rodapé das respostas que fecham um atendimento: a pessoa não precisa saber de /reset.
const RODAPE_RECOMECAR = '↩️ _Para começar um novo atendimento, é só mandar *início*._';
const ACOES_QUE_FECHAM = new Set(['emergencia', 'orientar', 'responder_rag']);

// ── Comandos ──────────────────────────────────────────────────

const comandosReset = [
  "/reset", "reset", "reiniciar", "comecar de novo", "começar de novo", "comecar dnv",
  "vamos comecar dnv", "vamos começar de novo", "voltar pro inicio", "voltar para o inicio",
  "voltar ao inicio", "inicio", "início", "menu", "cancelar",
  "recomecar", "recomeçar", "novo atendimento", "nova consulta", "voltar ao começo", "voltar pro começo",
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
  return t.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[.!]+$/, "").trim();
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

export function ehComandoApagar(entrada: string): boolean {
  const n = entrada.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
  return /^\/?(apagar|excluir)( meus? (dados|historico|conversa))?$/.test(n)
    || /^(apagar|excluir) (meus? )?(dados|historico|conversa)$/.test(n);
}

// ── Localização ───────────────────────────────────────────────

function detectarPedidoLocalizacao(texto: string): TipoUsuario | null {
  const n = texto.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
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

const CLINICA_RE = /\b(dor|falta de ar|desmaio|sangramento|febre|vomito|confus|tontura|peito|respir|convuls|acidente|queimad|trauma|pior|piorou|sinto|tosse|barriga|cabeca)\b/;
const CONVERSA_RE = /^(oi|ola|obrigad[oa]|valeu|vlw|tchau|ate mais|blz|beleza|tudo bem|bom dia|boa tarde|boa noite|nao sei|talvez|hm+|kkk+)$/;
const PERGUNTA_RE = /\?|\b(qual|quais|como|quando|porque|por que|o que|onde|dif[a-z]{3,})\b/;

// Resposta curta, sem sintoma, pergunta ou conversa = bairro/cidade.
function pareceLocal(textoLimpo: string): boolean {
  const palavras = textoLimpo.split(/\s+/).filter(Boolean);
  return (
    palavras.length >= 1 && palavras.length <= 7 &&
    !CLINICA_RE.test(textoLimpo) && !PERGUNTA_RE.test(textoLimpo) &&
    !CONVERSA_RE.test(textoLimpo) && !matchSimNao(textoLimpo)
  );
}

function localRecente(estado: EstadoConversa) {
  const l = estado.ultimaLocalizacao;
  return l && Date.now() - l.em < LOCALIZACAO_VALIDA_MS ? l : null;
}

// ── Estado ────────────────────────────────────────────────────

function estadoNovo(): EstadoConversa {
  return JSON.parse(JSON.stringify(ESTADO_INICIAL)) as EstadoConversa;
}

async function obterEstado(canal: Canal): Promise<EstadoConversa> {
  return (await canal.carregar()) ?? estadoNovo();
}

async function executarBusca(
  canal: Canal, estado: EstadoConversa, lat: number, lng: number, tipo: TipoUsuario,
): Promise<void> {
  estado.ultimaLocalizacao = { lat, lng, em: Date.now() };
  estado.aguardandoLocalizacao = undefined;
  await canal.salvar(estado);

  await canal.enviar({ texto: "🔎 Buscando as unidades mais próximas, um instante..." });
  const parar = canal.digitando?.();
  try {
    console.log(`🔍 [${canal.sessaoLog}] Buscando ${tipo}`);
    const r = await buscarUnidades(lat, lng, tipo);
    console.log(`📦 [${canal.sessaoLog}] ${r.unidades.length} unidades (origem: ${r.origem})`);
    parar?.();
    await canal.enviar({ texto: formatarUnidades(r.unidades, lat, lng, tipo, { falhaServico: r.falhaServico }) });
  } catch (err) {
    parar?.();
    console.error("❌ Erro ao buscar unidades:", err);
    await canal.enviar({ texto: "❌ Erro ao buscar unidades próximas. Se for emergência, ligue 192 agora." });
  }
}

// Anexa a oferta de "unidade mais próxima" e marca no estado que estamos aguardando a localização.
function oferecerLocalizacao(
  canal: Canal,
  estado: EstadoConversa,
  resultado: { tipo: string; decisao?: { resposta_id: string } },
  mensagemBase: string,
): string {
  const tipoLocalizacao = tipoParaOferecer(resultado);
  if (!tipoLocalizacao) return mensagemBase;

  const { art, prox, nome } = artigoUnidade(tipoLocalizacao);
  const texto =
    mensagemBase +
    `\n\n📍 *Quer saber ${art} ${nome} mais ${prox}?* 🙋\n` +
    `Responda *"sim"* e me mande sua localização (${canal.local}) ou escreva seu *bairro e cidade*.`;

  estado.aguardandoLocalizacao = { ativo: true, tipo: tipoLocalizacao, mensagemOriginal: texto };
  return texto;
}

// ── Entradas ──────────────────────────────────────────────────

/** A pessoa compartilhou a localização (pino do WhatsApp ou GPS do celular). */
export async function atenderLocalizacao(canal: Canal, lat: number, lng: number): Promise<void> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    await canal.enviar({ texto: "📍 Localização inválida. Tente novamente." });
    return;
  }

  const estado = await obterEstado(canal);
  const aguardando = estado.aguardandoLocalizacao;
  if (aguardando?.ativo) {
    await executarBusca(canal, estado, lat, lng, aguardando.tipo);
    return;
  }

  estado.ultimaLocalizacao = { lat, lng, em: Date.now() };
  await canal.salvar(estado);
  await canal.enviar({
    texto: "📍 Localização recebida! O que você quer encontrar perto de você?\n\nResponda: *UPA*, *UBS* ou *hospital*.",
  });
}

/** A pessoa mandou áudio: transcreve e segue EXATAMENTE o mesmo caminho do texto. */
export async function atenderAudio(
  canal: Canal,
  obterAudio: () => Promise<{ buffer: Buffer; mime: string }>,
): Promise<void> {
  inc('total_audios');
  const parar = canal.digitando?.();
  let transcricao = '';
  try {
    await canal.enviar({ texto: "🎤 Um instante, estou ouvindo..." });
    const { buffer, mime } = await obterAudio();
    if (!buffer || buffer.length === 0) throw new Error("Buffer vazio");
    console.log(`🎤 [${canal.sessaoLog}] Áudio (${(buffer.length / 1024).toFixed(1)} KB)`);

    transcricao = await transcreverAudio(buffer, mime);
    if (!transcricao || transcricao.length < 3) {
      await new Promise((r) => setTimeout(r, 500));
      transcricao = await transcreverAudio(buffer, mime);
    }
  } catch (err) {
    console.error("❌ Erro ao baixar/transcrever áudio:", err);
  }
  parar?.();

  if (!transcricao || transcricao.length < 3) {
    await canal.enviar({
      texto:
        '🎤 Não consegui entender o áudio. Pode repetir em um lugar mais silencioso ou escrever? ' +
        'Em emergência, ligue 192.',
    });
    return;
  }
  await atenderTexto(canal, transcricao, true);
}

/** Mensagem de texto (ou a transcrição de um áudio). */
export async function atenderTexto(canal: Canal, cleanText: string, veioDeAudio = false): Promise<void> {
  console.log(`\n📩 [${canal.sessaoLog}]${veioDeAudio ? ' (áudio)' : ''} ${cleanText.slice(0, 40)}${cleanText.length > 40 ? '...' : ''}`);
  const textoLimpo = cleanText.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const prefixoAudio = veioDeAudio ? `_🎤 Ouvi: "${cleanText}"_\n\n` : '';

  // ── APAGAR DADOS (LGPD) ──
  if (ehComandoApagar(cleanText)) {
    try {
      await canal.apagar();
      await canal.enviar({
        texto:
          '🗑️ *Seus dados foram apagados.*\n\n' +
          'Removi o histórico desta conversa e o estado associado a ela. ' +
          'Se quiser recomeçar do zero, mande qualquer mensagem.',
      });
    } catch (err) {
      console.error('❌ Erro ao apagar dados:', err);
      await canal.enviar({
        texto: '⚠️ Não consegui apagar agora. Tente de novo em alguns minutos ou mande /reset para limpar a conversa local.',
      });
    }
    return;
  }

  // ── RESET ──
  if (ehComandoReset(cleanText)) {
    const estadoReset = estadoNovo();
    estadoReset.historico = [
      { role: 'user', content: '/reset', ts: Date.now() },
      { role: 'assistant', content: '🔄 Reiniciado.', ts: Date.now() },
    ];
    await canal.salvar(estadoReset);
    await canal.enviar({ texto: escolherAleatorio(RESETS) });
    return;
  }

  const estado = await obterEstado(canal);

  // ── LOCALIZAÇÃO POR TEXTO (depois de oferecermos a busca) ──
  if (estado.aguardandoLocalizacao?.ativo) {
    const decisao = matchSimNao(textoLimpo);
    const palavras = textoLimpo.split(/\s+/).filter(Boolean);
    const temPalavraClinica = CLINICA_RE.test(textoLimpo);
    const tipo = estado.aguardandoLocalizacao.tipo;
    const locRecente = localRecente(estado);

    if (decisao === "nao" && palavras.length <= 4 && !temPalavraClinica) {
      estado.aguardandoLocalizacao = undefined;
      await canal.salvar(estado);
      await canal.enviar({ texto: "Tudo bem! Se precisar, é só me chamar. 💙" });
      return;
    }

    if (decisao === "sim" && palavras.length <= 4 && !temPalavraClinica) {
      if (locRecente) {
        await executarBusca(canal, estado, locRecente.lat, locRecente.lng, tipo);
        return;
      }
      estado.aguardandoLocalizacao.aguardandoTexto = true;
      await canal.salvar(estado);
      await canal.enviar({
        texto: `📍 Me mande sua localização pelo ${canal.localDestaque}.\n\nOu escreva seu *bairro e cidade* (ex: "Icaraí, Niterói") que eu busco pra você.`,
      });
      return;
    }

    if (pareceLocal(textoLimpo)) {
      const coords = await buscarCoordenadasPorTexto(cleanText);
      if (coords) {
        await executarBusca(canal, estado, coords.lat, coords.lng, tipo);
      } else {
        inc('nominatim_falha');
        estado.aguardandoLocalizacao.aguardandoTexto = true;
        await canal.salvar(estado);
        await canal.enviar({
          texto: `Não consegui localizar esse endereço. Tente *bairro + cidade* ou compartilhe pelo ${canal.local}.`,
        });
      }
      return;
    }

    // Não era resposta sobre localização → segue para a triagem.
    estado.aguardandoLocalizacao = undefined;
  }

  // ── PEDIDO EXPLÍCITO DE LOCALIZAÇÃO ("onde tem uma UPA?") ──
  const locGuardada = localRecente(estado);
  let pedidoLoc = detectarPedidoLocalizacao(cleanText);
  if (!pedidoLoc && locGuardada) {
    if (/^(a |o )?(upa|pronto socorro|pronto atendimento)$/.test(textoLimpo)) pedidoLoc = "UPA";
    else if (/^(a |o )?(ubs|posto( de saude)?|clinica da familia)$/.test(textoLimpo)) pedidoLoc = "UBS";
    else if (/^(o |um )?hospital$/.test(textoLimpo)) pedidoLoc = "HOSPITAL";
  }

  if (pedidoLoc) {
    if (locGuardada) {
      await executarBusca(canal, estado, locGuardada.lat, locGuardada.lng, pedidoLoc);
      return;
    }
    estado.aguardandoLocalizacao = { ativo: true, tipo: pedidoLoc, mensagemOriginal: cleanText, aguardandoTexto: true };
    await canal.salvar(estado);
    const { art, prox, nome } = artigoUnidade(pedidoLoc);
    await canal.enviar({
      texto: `${prefixoAudio}📍 Compartilhe sua localização (${canal.local}) ou escreva seu *bairro e cidade* que eu busco ${art} ${nome} mais ${prox}.`,
    });
    return;
  }

  // ── TRIAGEM (guarda → LLM decisor → validação) ──
  const parar = canal.digitando?.();
  try {
    const primeiraMensagem = (estado.historico?.length ?? 0) === 0;
    const { resultado, estado: novoEstado } = await processarTurno(cleanText, estado, {
      origem: veioDeAudio ? 'audio' : 'texto',
      sessao: canal.sessaoLog,
    });
    if (estado.ultimaLocalizacao && !novoEstado.ultimaLocalizacao) {
      novoEstado.ultimaLocalizacao = estado.ultimaLocalizacao;
    }

    let mensagemFinal = resultado.texto;
    if (primeiraMensagem && canal.boasVindasNaPrimeira) {
      if (resultado.acao === 'conversa') {
        // "oi" na 1ª mensagem: apresentação + convite (sem duplicar a pergunta do LLM).
        mensagemFinal = `${MENSAGEM_BOAS_VINDAS}\n\n${CONVITE_RELATO}`;
      } else if (resultado.acao === 'emergencia') {
        // Emergência: a orientação vem PRIMEIRO; a apresentação fica para depois.
        mensagemFinal = `${mensagemFinal}\n\n---\n\n${MENSAGEM_BOAS_VINDAS}`;
      } else {
        mensagemFinal = `${MENSAGEM_BOAS_VINDAS}\n\n---\n\n${mensagemFinal}`;
      }
    }
    mensagemFinal = oferecerLocalizacao(canal, novoEstado, resultado, mensagemFinal);
    if (resultado.acao && ACOES_QUE_FECHAM.has(resultado.acao)) {
      mensagemFinal = `${mensagemFinal}\n\n${RODAPE_RECOMECAR}`;
    }

    await canal.salvar(novoEstado);
    parar?.();
    // Quem mandou áudio recebe também um áudio curto, só com a resposta principal.
    await canal.enviar({ texto: `${prefixoAudio}${mensagemFinal}`, fala: veioDeAudio ? resultado.texto : undefined });
  } catch (err) {
    parar?.();
    throw err;
  }
}
