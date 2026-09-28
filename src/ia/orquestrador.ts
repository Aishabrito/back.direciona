// src/ia/orquestrador.ts
// Um único caminho para texto, áudio e API:
//
//   Mensagem
//     ↓
//   [Guarda regex crítica] ── pegou? → emergência direto (não chama LLM)
//     ↓
//   [Reformulou 3x?] ── sim → escalonamento para canal humano
//     ↓
//   [LLM decisor] ── falhou? → [fallback determinístico]
//     ↓
//   (acao=responder_rag → busca na base + LLM redige)
//     ↓
//   [Validação final]
//     ↓
//   Resposta + estado + log

import { detectarCriticoRegex, textoEmergencia, destinoDaCategoria } from './guarda_critica.js';
import { decidirComLLM } from './decisor.js';
import { decidirSemLLM } from './fallback.js';
import { responderComBase } from './base_conhecimento.js';
import { validarDecisao } from './validacao_final.js';
import { atualizarMemoria, deveAtualizarResumo, ehReformulacao } from './memoria.js';
import { PERGUNTAS } from './perguntas.js';
import {
  ESTADO_INICIAL, MEMORIA_VAZIA, VERSAO_REGRAS,
  type Decisao, type DecisaoRegras, type DestinoDecisor, type EstadoConversa,
  type RelatoEstruturado, type TurnoResultado, type UltimaPergunta,
} from './tipos.js';
import { inc, incDecisao, incDestino, metricas } from '../servicos/metricas.js';
import { logTurno, iniciarTimer } from '../servicos/log_conversa.js';
import type { UsoLLM } from '../servicos/ia.js';
import { normalizarTexto } from './normalizar.js';

export { ESTADO_INICIAL };

export type OpcoesTurno = { origem?: 'texto' | 'audio' | 'api'; sessao?: string };

const MAX_HISTORICO = 12;
// Mensagem original + 2 reformulações = 3 tentativas sem sucesso → escala.
const FALHAS_PARA_ESCALAR = 2;

export const TEXTO_ESCALONAMENTO =
  'Desculpe, parece que não estou conseguindo te ajudar direito. 🙏\n\n' +
  '• Se for *urgente* (falta de ar, dor no peito, desmaio, confusão), ligue *192 (SAMU)*.\n' +
  '• Para falar com uma pessoa sobre dúvidas de saúde e do SUS: *Disque Saúde 136* (ligação gratuita).\n' +
  '• Você também pode ir direto à UBS mais próxima.\n\n' +
  'Se quiser, tente me contar de outro jeito, com outras palavras — ou mande *reiniciar*.';

const TEXTO_ERRO_TECNICO =
  '⚠️ Estou com dificuldade técnica no momento. ' +
  'Se for urgente (falta de ar, dor no peito, desmaio, confusão), ligue *192* agora. ' +
  'Senão, tente de novo em 1 minuto.';

// Campos do "caso" atual (triagem em andamento). A memória e o histórico sobrevivem ao caso.
const CASO_VAZIO = {
  relatos: [] as RelatoEstruturado[],
  rodadasPerguntas: 0,
  texto_original_acumulado: '',
  perguntasJaFeitas: [] as string[],
  ultimaPergunta: undefined as UltimaPergunta | undefined,
  temaPergunta: undefined as string | undefined,
};

// "Piorou", "não melhorou", "continua doendo" depois de uma orientação: o caso anterior
// volta a valer para os pisos de segurança (só pode subir o nível, nunca baixar).
const RE_PIORA = /\b(piorou|piorando|ficou pior|(esta|ta|to|tou|estou|fiquei) pior|nao melhorou|nao passou|nao melhora|continua (com|doendo|sentindo|a dor|a febre)|voltou a (doer|sentir|ter)|comecou a ter tambem|apareceu (tambem|outra))\b/;

export function ehRelatoDePiora(texto: string): boolean {
  const n = normalizarTexto(texto);
  return RE_PIORA.test(n) && !/\bnao (piorou|ficou pior)\b/.test(n);
}

// Estados salvos por versões antigas podem não ter os campos novos.
function normalizarEstado(e: EstadoConversa | undefined): EstadoConversa {
  const base = e ?? ESTADO_INICIAL;
  return {
    ...ESTADO_INICIAL,
    ...base,
    relatos: base.relatos ?? [],
    perguntasJaFeitas: base.perguntasJaFeitas ?? [],
    historico: base.historico ?? [],
    memoria: base.memoria ?? { ...MEMORIA_VAZIA, fatos: {} },
    falhasSeguidas: base.falhasSeguidas ?? 0,
  };
}

function appendHistorico(estado: EstadoConversa, role: 'user' | 'assistant', content: string): EstadoConversa {
  const historico = [...(estado.historico ?? []), { role, content, ts: Date.now() }].slice(-MAX_HISTORICO);
  return { ...estado, historico };
}

function campoAlvoDaPergunta(texto: string): UltimaPergunta['campoAlvo'] {
  for (const lista of Object.values(PERGUNTAS)) {
    const p = lista.find((q) => q.texto === texto);
    if (p) return p.campoAlvo;
  }
  return undefined;
}

// ────────────────────────────────────────────────────
// Decisao → formato que o bot/API já consomem (DecisaoRegras)
// ────────────────────────────────────────────────────
const DESTINO_REGRAS: Record<DestinoDecisor, DecisaoRegras['destino']> = {
  SAMU_192: 'SAMU_192_PRONTO_SOCORRO',
  UPA: 'UPA_24H',
  UBS: 'UBS_CLINICA_DA_FAMILIA',
  CVV: 'CVV_188',
  CAPS: 'CAPS_OU_SERVICO_DE_SAUDE_MENTAL',
  MATERNIDADE: 'MATERNIDADE_PRONTO_SOCORRO_OBSTETRICO',
  NENHUM: 'FALLBACK',
};

function paraDecisaoRegras(d: Decisao): DecisaoRegras {
  const emergencia = d.acao === 'emergencia';
  const categoria: DecisaoRegras['categoria_interna'] =
    emergencia ? 'emergencia'
    : d.acao !== 'orientar' ? 'fora_do_escopo'
    : d.destino === 'UPA' ? 'urgencia'
    : d.destino === 'CAPS' ? 'saude_mental_sem_risco_imediato'
    : d.destino === 'MATERNIDADE' ? 'situacao_obstetrica'
    : 'baixa_gravidade';
  const nivel: DecisaoRegras['nivel'] =
    emergencia ? (d.destino === 'UPA' ? 'UPA_AGORA' : 'SAMU_AGORA')
    : d.acao === 'orientar' && d.destino === 'UPA' ? 'UPA_AGORA'
    : d.acao === 'orientar' && (d.destino === 'CAPS' || d.destino === 'MATERNIDADE') ? 'HOJE'
    : 'AGENDAR';
  return {
    categoria_interna: categoria,
    destino: DESTINO_REGRAS[d.destino],
    resposta_id: d.resposta_id ?? d.acao,
    regra_acionada: `${d.origem}:${d.acao}`,
    versao_regras: VERSAO_REGRAS,
    nivel,
    motivos: d.motivo_interno ? [d.motivo_interno] : [],
  };
}

// ────────────────────────────────────────────────────
// TURNO
// ────────────────────────────────────────────────────
export async function processarTurno(
  textoUsuario: string,
  estadoEntrada: EstadoConversa,
  opcoes: OpcoesTurno = {},
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  const timer = iniciarTimer();
  const estadoOriginal = normalizarEstado(estadoEntrada);
  const faseAnterior = estadoOriginal.fase;
  const texto = textoUsuario.trim();

  try {
    inc('total_mensagens');

    let estado = estadoOriginal;
    if (estado.fase === 'encerrado') estado = { ...estado, ...CASO_VAZIO, fase: 'inicio' };
    const coletando = estado.fase === 'coletando';

    const reformulou = ehReformulacao(texto, estado.historico);
    const falhas = reformulou ? (estado.falhasSeguidas ?? 0) + 1 : 0;
    if (reformulou) inc('reformulacoes');

    const textoCaso = coletando && estado.texto_original_acumulado
      ? `${estado.texto_original_acumulado} ${texto}`
      : estado.fase === 'orientado' && estado.ultimo_caso && ehRelatoDePiora(texto)
        ? `${estado.ultimo_caso} ${texto}`
        : texto;

    let decisao: Decisao;
    let uso: UsoLLM = { tokens_in: 0, tokens_out: 0 };
    let relatosFallback: RelatoEstruturado[] | null = null;
    let escalado = false;

    // 1. Guarda regex crítica — escala direto, sem LLM.
    const guarda = detectarCriticoRegex(texto);
    if (guarda.critico) {
      inc('guarda_regex');
      console.warn(`🚨 [guarda] ${guarda.categoria}${guarda.terceiro ? ' (terceiro)' : ''}`);
      decisao = {
        acao: 'emergencia',
        texto: textoEmergencia(guarda.categoria, guarda.terceiro),
        destino: destinoDaCategoria(guarda.categoria),
        pergunta_proxima: '',
        pergunta_rag: '',
        motivo_interno: `guarda: ${guarda.motivo}${guarda.terceiro ? ' (terceiro)' : ''}`,
        origem: 'guarda',
        resposta_id: guarda.categoria === 'suicidio' ? 'mental_emergencia_001' : 'emergencia_001',
      };
    } else if (falhas >= FALHAS_PARA_ESCALAR) {
      // 2. Loop de feedback: 3 tentativas sem sucesso → canal humano.
      inc('escalonamentos');
      escalado = true;
      decisao = {
        acao: 'conversa', texto: TEXTO_ESCALONAMENTO, destino: 'NENHUM',
        pergunta_proxima: '', pergunta_rag: '',
        motivo_interno: 'usuário reformulou 3x', origem: 'escalonamento', resposta_id: 'escalonamento',
      };
    } else {
      // 3. LLM decide; se falhar, caminho determinístico.
      const llm = await decidirComLLM({
        mensagem: texto, estado, textoCaso, reformulou,
        atualizarResumo: deveAtualizarResumo(estado.memoria),
      });
      if (llm) {
        inc('decisor_llm');
        decisao = llm.decisao;
        uso = llm.uso;
      } else {
        inc('decisor_fallback');
        const fb = decidirSemLLM(texto, estado, textoCaso);
        decisao = fb.decisao;
        relatosFallback = fb.relatos;
      }
    }

    // 4. RAG como ferramenta do decisor.
    if (decisao.acao === 'responder_rag') {
      const rag = await responderComBase(decisao.pergunta_rag || texto);
      decisao = { ...decisao, texto: rag.texto, resposta_id: `rag:${rag.topico_id}` };
      if (rag.uso) uso = { tokens_in: uso.tokens_in + rag.uso.tokens_in, tokens_out: uso.tokens_out + rag.uso.tokens_out };
    }

    // 5. Validação final.
    const validacao = validarDecisao(decisao, { textoCaso, estado });
    decisao = validacao.decisao;

    // Dúvida no meio da triagem: responde e retoma o caso de onde parou.
    if (coletando && decisao.acao === 'responder_rag' && estado.ultimaPergunta?.texto) {
      decisao = { ...decisao, texto: `${decisao.texto}\n\n↩️ *Voltando ao que você me contou:* ${estado.ultimaPergunta.texto}` };
    }
    if (validacao.alterou) {
      inc('validacao_alterou');
      console.warn(`🛡️ [validação] ${validacao.motivos.join(', ')}`);
    }

    // 6. Novo estado.
    let novo: EstadoConversa = appendHistorico(estado, 'user', texto);
    novo.memoria = atualizarMemoria(estado.memoria, decisao.fatos_novos, decisao.resumo);
    novo.falhasSeguidas = escalado ? 0 : falhas;

    if (decisao.acao === 'emergencia' || decisao.acao === 'orientar') {
      novo = { ...novo, ...CASO_VAZIO, fase: 'orientado', ultimo_caso: textoCaso.slice(-800) };
    } else if (decisao.acao === 'perguntar') {
      const pergunta = decisao.pergunta_proxima || decisao.texto;
      const anteriores = coletando ? estado.perguntasJaFeitas : [];
      novo = {
        ...novo,
        fase: 'coletando',
        relatos: relatosFallback ?? (coletando ? estado.relatos : []),
        rodadasPerguntas: (coletando ? estado.rodadasPerguntas : 0) + 1,
        texto_original_acumulado: textoCaso,
        perguntasJaFeitas: [...anteriores, pergunta],
        ultimaPergunta: {
          id: `p${anteriores.length + 1}`,
          campoAlvo: campoAlvoDaPergunta(pergunta),
          texto: pergunta,
        },
      };
    }
    novo = appendHistorico(novo, 'assistant', decisao.texto);

    // 7. Resultado.
    const resultado: TurnoResultado = decisao.acao === 'perguntar'
      ? { tipo: 'perguntas', texto: decisao.texto, perguntas: [decisao.pergunta_proxima], tema: decisao.origem, acao: decisao.acao }
      : { tipo: 'orientacao', texto: decisao.texto, decisao: paraDecisaoRegras(decisao), acao: decisao.acao };

    incDecisao(decisao.acao);
    if (decisao.destino !== 'NENHUM') incDestino(decisao.destino);
    metricas.llm_tokens_in += uso.tokens_in;
    metricas.llm_tokens_out += uso.tokens_out;

    logTurno({
      ts: new Date().toISOString(),
      sessao: opcoes.sessao,
      origem_msg: opcoes.origem ?? 'texto',
      msg: texto.slice(0, 200),
      acao: decisao.acao,
      destino: decisao.destino,
      origem_decisao: decisao.origem,
      foi_guarda_regex: decisao.origem === 'guarda',
      motivo_interno: decisao.motivo_interno,
      latencia_ms: timer(),
      llm_tokens_in: uso.tokens_in,
      llm_tokens_out: uso.tokens_out,
      validacao_alterou: validacao.alterou,
      validacao_motivos: validacao.motivos.length ? validacao.motivos : undefined,
      reformulou,
      falhas_seguidas: novo.falhasSeguidas ?? 0,
      escalado,
      fase_anterior: faseAnterior,
      fase_nova: novo.fase,
    });

    return { resultado, estado: novo };
  } catch (err: any) {
    console.error('❌ [orquestrador] erro no turno:', err?.message || err);
    logTurno({
      ts: new Date().toISOString(), sessao: opcoes.sessao, origem_msg: opcoes.origem ?? 'texto',
      msg: texto.slice(0, 200), acao: 'erro', destino: 'NENHUM', origem_decisao: 'erro',
      foi_guarda_regex: false, latencia_ms: timer(), llm_tokens_in: 0, llm_tokens_out: 0,
      validacao_alterou: false, reformulou: false, falhas_seguidas: 0, escalado: false,
      fase_anterior: faseAnterior, fase_nova: faseAnterior, erro: String(err?.message || err),
    });
    return {
      resultado: {
        tipo: 'orientacao',
        texto: TEXTO_ERRO_TECNICO,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK', resposta_id: 'erro_tecnico',
          regra_acionada: 'erro_tecnico', versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['erro técnico'],
        },
      },
      estado: estadoOriginal,
    };
  }
}
