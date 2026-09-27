// src/ia/orquestrador.ts
// Onda B: LLM decide o roteamento principal.
// Guarda crítica regex roda ANTES do LLM, com permissão de triagem
// em casos ambíguos (desmaio, terceiro, dor torácica isolada, etc).

import { registrarDecisao } from './auditoria.js';
import { interpretarRelato } from './extrator_de_informacoes.js';
import {
  mensagemPorId,
  ehPedidoDiagnostico,
  ehPedidoMedicamento,
} from './mensagens.js';
import { responderDaBase, temTopicoRelevante } from './base_conhecimento.js';
import { aplicarMotor } from './motor_de_regras.js';
import {
  escolherTemaPergunta, escolherProximaPergunta,
  interpretarRespostaCurta, type TemaPergunta,
} from './perguntas.js';
import { checarFaq } from './faq.js';
import { comporResposta } from './compositor_mensagem.js';
import { classificarNivel } from './sinais_criticos.js';
import {
  RELATO_VAZIO, VERSAO_REGRAS,
  type EstadoConversa, type RelatoEstruturado, type TurnoResultado,
  type MensagemHistorico,
} from './tipos.js';
import { mesclarRelatos } from './validador_de_saida.js';
import { normalizarTexto } from './normalizar.js';
import { inc, incDecisao, incDestino } from '../servicos/metricas.js';
import { logTurno, iniciarTimer } from '../servicos/log_conversa.js';
import { escolherAleatorio, DESPEDIDAS, ABERTURAS_RAG } from './variacao.js';
import {
  detectarCriticoRegex,
  permiteTriagemAntes,
  perguntaTriagemCritica,
} from './guarda_critica.js';

export const ESTADO_INICIAL: EstadoConversa = {
  relatos: [],
  rodadasPerguntas: 0,
  texto_original_acumulado: '',
  fase: 'inicio',
  perguntasJaFeitas: [],
  historico: [],
};

const MAX_HISTORICO = 12;

function appendHistorico(
  estado: EstadoConversa,
  role: 'user' | 'assistant',
  content: string,
): EstadoConversa {
  const historico = [
    ...(estado.historico ?? []),
    { role, content, ts: Date.now() },
  ].slice(-MAX_HISTORICO);
  return { ...estado, historico };
}

function formatarHistorico(historico: MensagemHistorico[] | undefined): string {
  if (!historico || historico.length === 0) return '(sem histórico)';
  return historico
    .map((m) => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
    .join('\n');
}

// ────────────────────────────────────────────────────
// Detecções (FALLBACK quando o LLM falha)
// ────────────────────────────────────────────────────
const SAUDACOES_BASE = [
  'oi', 'ola', 'opa', 'eai', 'eae', 'oie', 'oii', 'e ai',
  'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bom',
];

function colapsarLetras(texto: string): string {
  return texto.replace(/(.)\1+/g, '$1');
}

function ehSaudacaoRegex(texto: string): boolean {
  const n = normalizarTexto(texto);
  const palavras = n.split(/\s+/).filter(Boolean);
  if (palavras.length === 0 || palavras.length > 4) return false;
  const colapsado = colapsarLetras(n);
  return SAUDACOES_BASE.some((s) => {
    const sColapsado = colapsarLetras(s);
    return colapsado === sColapsado || colapsado.startsWith(sColapsado + ' ');
  });
}

function ehAgradecimentoRegex(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /^(obrigad|valeu|brigad|thanks|vlw|muito obrigad)/.test(n);
}

function ehConfirmacaoOrientacaoRegex(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /^(ok|já fui|ja fui|estou indo|cheguei|obrigad|valeu|brigad|entendi|certo|beleza|blz|já chamei|ja chamei|chamei|vou (ligar|chamar)|liguei)\b/.test(n);
}

function ehNovoCasoRegex(textoNorm: string): boolean {
  return /\b(novo caso|outra coisa|agora e outro|mudando de assunto|deixa eu perguntar outra|outro sintoma|comecar de novo|começar de novo)\b/.test(textoNorm);
}

function pedidoDiagnosticoAmplo(textoNorm: string): boolean {
  const DOENCAS =
    'gripe|influenza|dengue|zika|chikungunya|covid|corona|coronavirus|pneumonia|infarto|avc|derrame|virose|meningite|apendicite|cancer|gastrite|sinusite|amigdalite|bronquite|asma|hepatite|tuberculose|hanseniase';
  const SUSPEITA = 'acho|acredito|penso|imagino|suspeito|desconfio|sera';
  const VERBO_PROPRIO = 'estou\\s+com|to\\s+com|tou\\s+com|tenho|peguei|pega';

  if (/\bmeus?\s+sintomas?\s+(sao|e|eh|podem ser|pode ser)\b/.test(textoNorm)) return true;
  const re1 = new RegExp(`\\b(${SUSPEITA})\\s+(q|que)?\\s*(${VERBO_PROPRIO})\\b`);
  if (re1.test(textoNorm)) return true;
  const re2 = new RegExp(`\\b(${SUSPEITA}|deve|pode)\\s+(q|que)?\\s*((e|eh)\\s+)?\\b(${DOENCAS})\\b`);
  if (re2.test(textoNorm)) return true;
  if (/\b(to|estou|tou)\s+(achando|pensando|suspeitando)\b/.test(textoNorm)) return true;
  const re3 = new RegExp(`\\b(e|eh|seria|sera)\\s+(${DOENCAS})\\b`);
  if (re3.test(textoNorm)) return true;
  if (/\b(isso|isto|esse|essa)\s+(e|eh|é)\s+(grave|serio|sério|perigoso|ruim|mau)\b/.test(textoNorm)) return true;

  return false;
}

function descreveMalEstarVago(textoNorm: string): boolean {
  return /\b(estou|to|tou|me sinto|sinto|ando|venho)\b[^.!?]{0,25}\b(mal|ruim|doente|pessimo|péssimo|muito mal|muito ruim|nao estou bem|não estou bem|nao to bem|não to bem|nao tou bem|não tou bem|nao estou nada bem|passando mal|me sentindo mal|me sentindo ruim)\b/i.test(textoNorm);
}

function descreveQueixaPropriaRegex(textoNorm: string): boolean {
  return /\b(estou|to|tou|sinto|senti|me sinto|tenho|ando|venho)\b.{0,40}\b(com|sentindo|me sentindo|tendo|ficando)\b/.test(textoNorm);
}

function parecePergunta(texto: string): boolean {
  if (/\?/.test(texto)) return true;
  const n = normalizarTexto(texto);
  return /\b(o que|oq|como|por que|porque|pq|quando|qdo|qnd|qual|quais|quanto|quantos|quantas|quem|onde|kd|serve|devo|posso|pra que|me explica|explica|me fala sobre|fala sobre|significa|eh|sera|tem como|existe)\b/.test(n);
}

function consolidar(estado: EstadoConversa): RelatoEstruturado {
  const base = estado.relatos.reduce((acc, item) => mesclarRelatos(acc, item), { ...RELATO_VAZIO });
  return { ...base, texto_original_acumulado: estado.texto_original_acumulado || '' };
}

function temSintomaClinico(relato: RelatoEstruturado): boolean {
  return (
    relato.sintomas.length > 0 ||
    relato.sinais_alerta.length > 0 ||
    relato.risco_mental !== 'nao_mencionado' ||
    relato.autodiagnostico_grave !== null ||
    (relato.sinais_neurologicos || []).length > 0 ||
    (relato.sinais_trauma || []).length > 0 ||
    (relato.sinais_obstetricos || []).length > 0
  );
}

const PALAVRAS_VAZIAS = new Set([
  'isso', 'isto', 'aquilo', 'esse', 'essa', 'este', 'esta',
  'aquele', 'aquela', 'papo', 'reto', 'coisa', 'negocio', 'negócio',
  'grave', 'serio', 'perigoso', 'ruim', 'mau',
  'qual', 'quais', 'quanto', 'quantos', 'quantas', 'quem',
  'minha', 'meu', 'seu', 'sua', 'nossa', 'nosso',
  'idade', 'nome', 'telefone', 'endereco', 'endereço',
  'flamengo', 'corinthians', 'palmeiras', 'libertadores', 'brasileirao', 'brasileirão',
  'capital', 'franca', 'frança', 'piada', 'tempo', 'previsao', 'previsão',
]);

const SUBSTANTIVOS_CLINICOS = /\b(febre|dor|tosse|falta de ar|desmaio|convuls|sangramento|mancha|vomit|diarr|nausea|náusea|tontura|cefaleia|pressao|pressão|açúcar|acucar|glicemia|infec|alergia|queimad|trauma|fratura|entorse|covid|dengue|gripe|zika|chikungunya|pneumonia|asma|bronquite|tubercul|hanseniase|hanseníase|hepatite|hipertens|diabetes|cancer|câncer|avc|infarto|derrame|meningite|apendicite|convulsao|convulsão|anemia|colesterol|obesidade|desidrat|insolacao|insolação|hipotermia|caps|sus|ubs|upa|samu|vacin|cartao|cartão|consulta|exame|medicamento|remedio|remédio)\b/i;

function perguntaTemConteudoMinimo(pergunta: string): boolean {
  if (SUBSTANTIVOS_CLINICOS.test(pergunta)) return true;
  const palavrasSignificativas = pergunta
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter((p) => p.length > 3 && !PALAVRAS_VAZIAS.has(p));
  return palavrasSignificativas.length >= 2;
}

// ============================================================
// RESPONDEDORES AUXILIARES
// ============================================================

function decisaoBase(respostaId: string, regra: string, motivos: string[] = []) {
  return {
    categoria_interna: 'fora_do_escopo' as const,
    destino: 'FALLBACK' as const,
    resposta_id: respostaId,
    regra_acionada: regra,
    versao_regras: VERSAO_REGRAS,
    nivel: 'AGENDAR' as const,
    motivos,
  };
}

function respostaDespedida(estado: EstadoConversa) {
  return {
    estado: { ...estado, fase: 'encerrado' as const },
    resultado: {
      tipo: 'orientacao' as const,
      texto: escolherAleatorio(DESPEDIDAS),
      decisao: decisaoBase('encerramento_001', 'despedida', ['despedida']),
    },
  };
}

function respostaForaEscopo(estado: EstadoConversa, reset: boolean = false) {
  const msg = mensagemPorId('fora_escopo_001');
  return {
    estado: reset ? { ...ESTADO_INICIAL, historico: estado.historico ?? [] } : estado,
    resultado: {
      tipo: 'orientacao' as const,
      texto: msg.texto,
      decisao: decisaoBase('fora_escopo_001', 'fora_do_escopo', ['fora de escopo']),
    },
  };
}

function respostaRecusaDiagnostico(estado: EstadoConversa) {
  const msg = mensagemPorId('recusa_diagnostico');
  return {
    estado,
    resultado: {
      tipo: 'orientacao' as const,
      texto: msg.texto,
      decisao: decisaoBase('recusa_diagnostico', 'bloqueio_diagnostico', ['bloqueio']),
    },
  };
}

function respostaRecusaMedicamento(estado: EstadoConversa) {
  const msg = mensagemPorId('recusa_medicamento');
  return {
    estado,
    resultado: {
      tipo: 'orientacao' as const,
      texto: msg.texto,
      decisao: decisaoBase('recusa_medicamento', 'bloqueio_medicamento', ['bloqueio']),
    },
  };
}

function respostaPerguntaVaga(estado: EstadoConversa) {
  return {
    estado: { ...estado, fase: 'coletando' as const },
    resultado: {
      tipo: 'orientacao' as const,
      texto: 'Pode me contar um pouco mais? Sobre o que você quer saber exatamente?',
      decisao: decisaoBase('vago_contexto', 'rag_pergunta_vaga', ['pergunta vaga']),
    },
  };
}

function respostaIniciaTriagem(
  estado: EstadoConversa,
  perguntasJaFeitas: string[],
  textoUsuario: string,
  prefixo?: string,
) {
  const pergunta = escolherProximaPergunta('vago', RELATO_VAZIO, perguntasJaFeitas);
  if (!pergunta) return null;

  return {
    estado: {
      ...estado,
      fase: 'coletando' as const,
      temaPergunta: 'vago',
      rodadasPerguntas: 1,
      perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
      ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
      texto_original_acumulado: textoUsuario,
    },
    resultado: {
      tipo: 'perguntas' as const,
      tema: 'vago',
      perguntas: [pergunta.texto],
      texto: prefixo ? `${prefixo} ${pergunta.texto}` : pergunta.texto,
    },
  };
}

// [GUARDA CRÍTICA] Resposta de emergência.
// Nunca nomeia doença — apenas direciona ao serviço.
function respostaEmergenciaGuard(
  estado: EstadoConversa,
  motivo: string,
  categoria: string,
): { resultado: TurnoResultado; estado: EstadoConversa } {
  console.warn(`🚨 [guarda] crítico detectado: ${categoria} (${motivo})`);

  const textos: Record<string, string> = {
    suicidio:
      '💛 Estou aqui com você. Se você está pensando em se machucar, ligue agora para o *CVV 188* (24h, gratuito, sigiloso). Em emergência, ligue *192 (SAMU)* ou vá a uma UPA.',
    dor_toracica:
      '⚠️ Esse sintoma precisa de atendimento imediato. Ligue *192 (SAMU)* agora. Não espere passar. Não dirija sozinho.',
    falta_de_ar:
      '⚠️ Esse sintoma precisa de atendimento imediato. Ligue *192 (SAMU)* agora ou vá imediatamente à UPA mais próxima.',
    avc:
      '⚠️ Esses sinais precisam de atendimento imediato. Ligue *192 (SAMU)* agora. Se possível, anote a hora que começou.',
    desmaio:
      '⚠️ Essa situação precisa de atendimento imediato. Ligue *192 (SAMU)* agora ou vá imediatamente à UPA.',
    convulsao:
      '⚠️ Essa situação precisa de atendimento imediato. Ligue *192 (SAMU)* agora. Proteja a cabeça, não coloque nada na boca.',
    sangramento:
      '⚠️ Esse sintoma precisa de atendimento imediato. Ligue *192 (SAMU)* agora ou vá imediatamente à UPA.',
    bebe_febre:
      '⚠️ Bebê pequeno com febre precisa de avaliação imediata. Vá agora a uma UPA ou ligue *192 (SAMU)*.',
    obstetrico:
      '⚠️ Essa situação precisa de avaliação imediata. Procure a maternidade de referência ou ligue *192 (SAMU)*.',
  };

  const texto = textos[categoria] ?? '⚠️ Seus sintomas exigem atendimento imediato. Ligue *192 (SAMU)* ou vá a uma UPA agora.';

  const comLocalizacao = texto +
    '\n\n📍 *Quer saber a UPA ou hospital mais próximo?*\n' +
    'Responda *"sim"* e me mande sua localização (📎 → Localização) ou escreva seu *bairro e cidade*.';

  const estadoApos: EstadoConversa = {
    relatos: [],
    rodadasPerguntas: 0,
    texto_original_acumulado: '',
    fase: 'orientado',
    perguntasJaFeitas: [],
    historico: estado.historico,
    aguardandoLocalizacao: { ativo: true, tipo: 'HOSPITAL', mensagemOriginal: comLocalizacao },
  };

  return {
    estado: estadoApos,
    resultado: {
      tipo: 'orientacao',
      texto: comLocalizacao,
      decisao: {
        categoria_interna: 'emergencia',
        destino: 'SAMU_192_PRONTO_SOCORRO',
        resposta_id: `guarda_${categoria}`,
        regra_acionada: `guarda_critica_${categoria}`,
        versao_regras: VERSAO_REGRAS,
        nivel: 'SAMU_AGORA',
        motivos: [motivo],
      },
    },
  };
}

// ============================================================
// WRAPPERS PÚBLICOS
// ============================================================

function respostaFallbackTurno(estado: EstadoConversa, erro: any): {
  resultado: TurnoResultado;
  estado: EstadoConversa;
} {
  console.error('❌ [orquestrador] erro no turno:', erro?.message || erro);
  return {
    resultado: {
      tipo: 'orientacao',
      texto:
        '⚠️ Estou com dificuldade técnica no momento. ' +
        'Se for urgente (falta de ar, dor no peito, desmaio, confusão), ligue 192 agora. ' +
        'Senão, tente de novo em 1 minuto.',
      decisao: decisaoBase('erro_tecnico', 'erro_tecnico', ['erro técnico']),
    },
    estado,
  };
}

export async function processarTurno(
  textoUsuario: string,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  try {
    const timer = iniciarTimer();
    const faseAnterior = estadoEntrada.fase ?? 'inicio';

    const estadoComUser = appendHistorico(estadoEntrada, 'user', textoUsuario);
    const { resultado, estado } = await processarTurnoInterno(textoUsuario, estadoComUser);

    const estadoFinal = appendHistorico(
      { ...estado, historico: estadoComUser.historico ?? [] },
      'assistant',
      resultado.texto,
    );

    const decisao = resultado.tipo === 'orientacao' ? resultado.decisao : undefined;

    logTurno({
      ts: new Date().toISOString(),
      texto_usuario: textoUsuario.slice(0, 200),
      tamanho_historico: estadoFinal.historico?.length ?? 0,
      regra_acionada: decisao?.regra_acionada,
      nivel: decisao?.nivel,
      destino: decisao?.destino,
      resposta_id: decisao?.resposta_id,
      bloqueado: decisao?.resposta_id === 'base_bloqueada',
      fase_anterior: faseAnterior,
      fase_nova: estadoFinal.fase,
      latencia_ms: timer(),
    });

    return { resultado, estado: estadoFinal };
  } catch (err) {
    return respostaFallbackTurno(estadoEntrada, err);
  }
}

export async function processarTurnoComRelato(
  textoRepresentativo: string,
  relatoPronto: RelatoEstruturado,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  try {
    const timer = iniciarTimer();
    const faseAnterior = estadoEntrada.fase ?? 'inicio';

    const estadoComUser = appendHistorico(estadoEntrada, 'user', textoRepresentativo);
    const { resultado, estado } = await processarTurnoComRelatoInterno(
      textoRepresentativo,
      relatoPronto,
      estadoComUser,
    );

    const estadoFinal = appendHistorico(
      { ...estado, historico: estadoComUser.historico ?? [] },
      'assistant',
      resultado.texto,
    );

    const decisao = resultado.tipo === 'orientacao' ? resultado.decisao : undefined;

    logTurno({
      ts: new Date().toISOString(),
      texto_usuario: textoRepresentativo.slice(0, 200),
      tamanho_historico: estadoFinal.historico?.length ?? 0,
      regra_acionada: decisao?.regra_acionada,
      nivel: decisao?.nivel,
      destino: decisao?.destino,
      resposta_id: decisao?.resposta_id,
      bloqueado: decisao?.resposta_id === 'base_bloqueada',
      fase_anterior: faseAnterior,
      fase_nova: estadoFinal.fase,
      latencia_ms: timer(),
    });

    return { resultado, estado: estadoFinal };
  } catch (err) {
    return respostaFallbackTurno(estadoEntrada, err);
  }
}

// ============================================================
// PROCESSAR TURNO — interno (texto)
// ============================================================
async function processarTurnoInterno(
  textoUsuario: string,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  inc('total_mensagens');

  let estado = estadoEntrada;
  let fase = estado.fase ?? 'inicio';
  if (fase === 'encerrado') {
    estado = { ...ESTADO_INICIAL, historico: estado.historico ?? [] };
    fase = 'inicio';
  }

  let perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const textoNorm = normalizarTexto(textoUsuario);
  const historicoFmt = formatarHistorico(estado.historico);

  // ── 0. GUARDA CRÍTICA
  const guarda = detectarCriticoRegex(textoUsuario);
  if (guarda.critico) {
    const permitirTriagem = permiteTriagemAntes(textoUsuario, guarda.categoria, guarda.terceiro);

    if (!permitirTriagem) {
      incDecisao('SAMU_AGORA');
      incDestino('SAMU_192_PRONTO_SOCORRO');
      return respostaEmergenciaGuard(estado, guarda.motivo, guarda.categoria);
    }

    const perguntaCritica = perguntaTriagemCritica(guarda.categoria, guarda.terceiro);
    if (perguntaCritica) {
      console.log(`🟡 [guarda] triagem crítica antes: ${guarda.categoria} (terceiro: ${guarda.terceiro})`);
      return {
        estado: {
          ...estado,
          fase: 'coletando',
          temaPergunta: 'vago',
          rodadasPerguntas: 1,
          perguntasJaFeitas: [],
          ultimaPergunta: {
            id: `crit_${guarda.categoria}`,
            campoAlvo: 'sintomas',
            texto: perguntaCritica,
          },
          texto_original_acumulado: textoUsuario,
        },
        resultado: {
          tipo: 'perguntas',
          tema: 'vago',
          perguntas: [perguntaCritica],
          texto: perguntaCritica,
        },
      };
    }

    incDecisao('SAMU_AGORA');
    incDestino('SAMU_192_PRONTO_SOCORRO');
    return respostaEmergenciaGuard(estado, guarda.motivo, guarda.categoria);
  }

  // ── 1. Confirmação pós-orientação
  if (fase === 'orientado' && ehConfirmacaoOrientacaoRegex(textoUsuario)) {
    return respostaDespedida(estado);
  }

  // ── 2. Extração via LLM
  const respostaCurta = interpretarRespostaCurta(textoUsuario, estado.ultimaPergunta);
  const extraido = respostaCurta
    ? ({ ...RELATO_VAZIO, ...respostaCurta, texto_original_acumulado: '' } as RelatoEstruturado)
    : await interpretarRelato(textoUsuario, historicoFmt);

  // ── 3. Novo caso
  if (fase === 'orientado' && ehNovoCasoRegex(textoNorm)) {
    const msg = mensagemPorId('novo_caso_001');
    return {
      estado: { ...ESTADO_INICIAL, historico: estado.historico ?? [] },
      resultado: {
        tipo: 'orientacao',
        texto: msg.texto,
        decisao: decisaoBase('novo_caso_001', 'novo_caso', ['novo caso']),
      },
    };
  }

  // ── 4. Reset pós-orientado
  if (fase === 'orientado' && estado.relatos.length > 0) {
    const pareceContinuacao =
      ehConfirmacaoOrientacaoRegex(textoUsuario) ||
      ehAgradecimentoRegex(textoUsuario) ||
      ehNovoCasoRegex(textoNorm) ||
      (estado.ultimaPergunta ? !!respostaCurta : false);

    if (!pareceContinuacao) {
      console.log(`🔄 [orq] reset pós-orientado: "${textoUsuario.slice(0, 40)}"`);
      estado = { ...ESTADO_INICIAL, historico: [] };
      fase = 'inicio';
      perguntasJaFeitas = [];
    }
  }

  // ── 5. Segurança
  const nivelPre = classificarNivel(extraido);
  const sinalCriticoPre = nivelPre === 'critico';

  if (!sinalCriticoPre && !respostaCurta) {
    if (ehPedidoDiagnostico(textoUsuario) || pedidoDiagnosticoAmplo(textoNorm)) {
      return respostaRecusaDiagnostico(estado);
    }
    if (ehPedidoMedicamento(textoUsuario)) {
      return respostaRecusaMedicamento(estado);
    }
  }

  // ── 6. LLM DECIDE
  const intencoes = extraido.intencoes ?? [];
  const temConhecimento = intencoes.includes('conhecimento');
  const temNavegacao = intencoes.includes('navegacao');
  const temRelatoIntent = intencoes.includes('relato');
  const temSaudacaoIntent = intencoes.includes('saudacao');
  const temAgradecimentoIntent = intencoes.includes('agradecimento');
  const temOutroIntent = intencoes.includes('outro');

  const temSintoma = temSintomaClinico(extraido);
  const nivelInicial = classificarNivel(extraido);
  const sinalCriticoInicial = nivelInicial === 'critico';
  const perguntaRAG = extraido.pergunta || textoUsuario;

  const llmConfiavel = intencoes.length > 0;

  // 6a. OUTRO
  if (
    llmConfiavel && temOutroIntent && !temSintoma &&
    !temConhecimento && !temNavegacao && !temRelatoIntent &&
    !temSaudacaoIntent && !temAgradecimentoIntent
  ) {
    return respostaForaEscopo(estado, true);
  }

  // 6b. SAUDAÇÃO
  if (llmConfiavel && temSaudacaoIntent && !temSintoma && !respostaCurta) {
    const r = respostaIniciaTriagem(estado, perguntasJaFeitas, textoUsuario);
    if (r) return r;
    return respostaForaEscopo(estado);
  }

  // 6c. AGRADECIMENTO
  if (llmConfiavel && temAgradecimentoIntent && !temSintoma) {
    return {
      estado: { ...estado, fase: 'orientado' },
      resultado: {
        tipo: 'orientacao',
        texto: mensagemPorId('encerramento_001').texto,
        decisao: decisaoBase('encerramento_001', 'agradecimento', ['encerramento']),
      },
    };
  }

  // 6d. MULTI-INTENT
  if (llmConfiavel && temConhecimento && temRelatoIntent && !sinalCriticoInicial && !respostaCurta) {
    if (perguntaTemConteudoMinimo(perguntaRAG)) {
      const temTopico = await temTopicoRelevante(perguntaRAG);
      if (temTopico) {
        const respostaBase = await responderDaBase(perguntaRAG, historicoFmt);
        if (respostaBase) {
          const cabecalho =
            respostaBase.origem === 'fallback_direto' && respostaBase.titulo
              ? `*${respostaBase.titulo}*\n\n`
              : '';

          const textoAcumuladoMI = estado.texto_original_acumulado
            ? `${estado.texto_original_acumulado} ${textoUsuario}`
            : textoUsuario;
          const relatosMI = [...estado.relatos, extraido];
          const atualMI = consolidar({
            ...estado,
            relatos: relatosMI,
            texto_original_acumulado: textoAcumuladoMI,
          });
          const nivelMI = classificarNivel(atualMI);

          if (nivelMI === 'critico') {
            const decisaoCritica = aplicarMotor(atualMI, textoAcumuladoMI);
            const msgCritica = comporResposta({
              relato: atualMI,
              decisao: decisaoCritica,
              mensagemAprovada: mensagemPorId(decisaoCritica.resposta_id).texto,
            });
            registrarDecisao(decisaoCritica);
            incDecisao(decisaoCritica.nivel);
            incDestino(decisaoCritica.destino);
            const mensagemFinal = `${cabecalho}${respostaBase.corpo}\n\n---\n\n${msgCritica}`;
            return {
              estado: {
                relatos: [],
                rodadasPerguntas: 0,
                texto_original_acumulado: '',
                fase: 'orientado',
                perguntasJaFeitas: [],
                historico: estado.historico,
              },
              resultado: { tipo: 'orientacao', texto: mensagemFinal, decisao: decisaoCritica },
            };
          }

          const temaMI = escolherTemaPergunta({
            sintomas: atualMI.sintomas, idade_grupo: atualMI.idade_grupo,
            gestante: atualMI.gestante, risco_mental: atualMI.risco_mental,
            falta_de_ar: atualMI.falta_de_ar, febre: atualMI.febre,
            sinais_trauma: atualMI.sinais_trauma,
          });
          const perguntaMI = escolherProximaPergunta(temaMI, atualMI, perguntasJaFeitas);

          if (perguntaMI) {
            const mensagemFinal = `${cabecalho}${respostaBase.corpo}\n\n---\n\n${perguntaMI.texto}`;
            return {
              estado: {
                relatos: relatosMI,
                rodadasPerguntas: estado.rodadasPerguntas + 1,
                temaPergunta: temaMI,
                texto_original_acumulado: textoAcumuladoMI,
                fase: 'coletando',
                perguntasJaFeitas: [...perguntasJaFeitas, perguntaMI.id],
                ultimaPergunta: {
                  id: perguntaMI.id,
                  campoAlvo: perguntaMI.campoAlvo,
                  texto: perguntaMI.texto,
                },
                historico: estado.historico,
              },
              resultado: {
                tipo: 'orientacao',
                texto: mensagemFinal,
                decisao: decisaoBase(
                  respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento_multi',
                  'base_conhecimento_multi',
                  ['base de conhecimento', 'multi-intent'],
                ),
              },
            };
          }

          const abertura = Math.random() < 0.4 && !respostaBase.bloqueado
            ? `${escolherAleatorio(ABERTURAS_RAG)}\n\n`
            : '';
          const rodape = '\n\n_Sobre o que você mencionou, me conta mais: desde quando começou?_';
          const mensagemFinal = `${abertura}${cabecalho}${respostaBase.corpo}${rodape}`;
          return {
            estado: {
              ...estado,
              relatos: relatosMI,
              texto_original_acumulado: textoAcumuladoMI,
              fase: 'coletando',
            },
            resultado: {
              tipo: 'orientacao',
              texto: mensagemFinal,
              decisao: decisaoBase('base_conhecimento_multi', 'base_conhecimento_multi', [
                'base de conhecimento', 'multi-intent',
              ]),
            },
          };
        }
      }
    }
  }

  // 6e. CONHECIMENTO puro
  if (llmConfiavel && temConhecimento && !temNavegacao && !temRelatoIntent && !sinalCriticoInicial && !respostaCurta) {
    if (!perguntaTemConteudoMinimo(perguntaRAG)) {
      return respostaPerguntaVaga(estado);
    }
    const temTopico = await temTopicoRelevante(perguntaRAG);
    if (temTopico) {
      const respostaBase = await responderDaBase(perguntaRAG, historicoFmt);
      if (respostaBase) {
        const cabecalho =
          respostaBase.origem === 'fallback_direto' && respostaBase.titulo
            ? `*${respostaBase.titulo}*\n\n`
            : '';
        const rodape = respostaBase.bloqueado
          ? ''
          : '\n\n_Se tiver algum sintoma agora, é só me contar que eu te oriento onde buscar atendimento._';
        const abertura = Math.random() < 0.4 && !respostaBase.bloqueado
          ? `${escolherAleatorio(ABERTURAS_RAG)}\n\n`
          : '';
        const mensagem = `${abertura}${cabecalho}${respostaBase.corpo}${rodape}`;

        return {
          estado: { ...estado, fase: 'orientado' },
          resultado: {
            tipo: 'orientacao',
            texto: mensagem,
            decisao: decisaoBase(
              respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento',
              'base_conhecimento',
              respostaBase.bloqueado ? ['base bloqueada por segurança'] : ['base de conhecimento'],
            ),
          },
        };
      }
    }
    return respostaPerguntaVaga(estado);
  }

  // ── 7. FALLBACK REGEX
  if (!llmConfiavel) {
    console.log(`⚠️ [orq] LLM não retornou intenções, usando fallback regex`);

    if (fase === 'orientado' && ehAgradecimentoRegex(textoUsuario) && !temSintoma) {
      return {
        estado: { ...estado, fase: 'orientado' },
        resultado: {
          tipo: 'orientacao',
          texto: mensagemPorId('encerramento_001').texto,
          decisao: decisaoBase('encerramento_001', 'agradecimento', ['encerramento']),
        },
      };
    }

    if (!temSintoma && !respostaCurta) {
      const faqEncontrada = checarFaq(textoUsuario);
      if (faqEncontrada) {
        return {
          estado: { ...estado, fase: 'orientado' },
          resultado: {
            tipo: 'orientacao',
            texto: faqEncontrada.resposta,
            decisao: decisaoBase(faqEncontrada.id, faqEncontrada.id, ['faq']),
          },
        };
      }
    }

    if (estado.relatos.length === 0 && ehSaudacaoRegex(textoUsuario) && !temSintoma && !respostaCurta) {
      const r = respostaIniciaTriagem(estado, perguntasJaFeitas, textoUsuario);
      if (r) return r;
    }
  }

  // ── 8. MAL-ESTAR VAGO
  const respondendoTriagemAgora = fase === 'coletando' && !!estado.ultimaPergunta;
  if (descreveMalEstarVago(textoNorm) && estado.relatos.length === 0 && !respondendoTriagemAgora && !respostaCurta) {
    const r = respostaIniciaTriagem(estado, perguntasJaFeitas, textoUsuario, 'Entendi.');
    if (r) return r;
  }

  // ── 9. RESET DE CONTEXTO
  const respondendoTriagem = fase === 'coletando' && !!estado.ultimaPergunta;
  const relatoComoQueixa = temRelatoIntent || descreveQueixaPropriaRegex(textoNorm);

  const nadaClinico =
    !temSintoma &&
    !parecePergunta(textoUsuario) &&
    !relatoComoQueixa &&
    !descreveMalEstarVago(textoNorm) &&
    !respostaCurta &&
    !respondendoTriagem;

  if (nadaClinico) {
    return respostaForaEscopo(estado, true);
  }

  // ── 10. FORA DE ESCOPO inicial
  if (
    !temSintoma && !relatoComoQueixa && !descreveMalEstarVago(textoNorm) &&
    estado.relatos.length === 0 && !respostaCurta && !respondendoTriagem
  ) {
    return respostaForaEscopo(estado);
  }

  // ── 11. TRIAGEM
  const textoAcumulado = estado.texto_original_acumulado
    ? `${estado.texto_original_acumulado} ${textoUsuario}`
    : textoUsuario;

  const relatos = [...estado.relatos, extraido];
  const atual = consolidar({ ...estado, relatos, texto_original_acumulado: textoAcumulado });
  const nivelAtual = classificarNivel(atual);

  const MAX_RODADAS = 2;

  if (nivelAtual === 'normal' && estado.rodadasPerguntas < MAX_RODADAS) {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas, idade_grupo: atual.idade_grupo,
      gestante: atual.gestante, risco_mental: atual.risco_mental,
      falta_de_ar: atual.falta_de_ar, febre: atual.febre,
      sinais_trauma: atual.sinais_trauma,
    });
    const pergunta = escolherProximaPergunta(tema, atual, perguntasJaFeitas);
    if (pergunta) {
      return {
        estado: {
          relatos,
          rodadasPerguntas: estado.rodadasPerguntas + 1,
          temaPergunta: tema,
          texto_original_acumulado: textoAcumulado,
          fase: 'coletando',
          perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
          ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
        },
        resultado: { tipo: 'perguntas', tema, perguntas: [pergunta.texto], texto: pergunta.texto },
      };
    }
  }

  if (nivelAtual === 'alerta') {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas, idade_grupo: atual.idade_grupo,
      gestante: atual.gestante, risco_mental: atual.risco_mental,
      falta_de_ar: atual.falta_de_ar, febre: atual.febre,
      sinais_trauma: atual.sinais_trauma,
    });
    const pergunta = escolherProximaPergunta(tema, atual, perguntasJaFeitas);
    if (pergunta && !perguntasJaFeitas.includes(pergunta.id)) {
      return {
        estado: {
          relatos,
          rodadasPerguntas: estado.rodadasPerguntas + 1,
          temaPergunta: tema,
          texto_original_acumulado: textoAcumulado,
          fase: 'coletando',
          perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
          ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
        },
        resultado: { tipo: 'perguntas', tema, perguntas: [pergunta.texto], texto: pergunta.texto },
      };
    }
  }

  const decisao = aplicarMotor(atual, textoAcumulado);

  if (decisao.categoria_interna === 'informacao_insuficiente') {
    const pergunta = escolherProximaPergunta('vago', atual, perguntasJaFeitas);
    if (pergunta) {
      return {
        estado: {
          relatos,
          rodadasPerguntas: estado.rodadasPerguntas + 1,
          temaPergunta: 'vago',
          texto_original_acumulado: textoAcumulado,
          fase: 'coletando',
          perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
          ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
        },
        resultado: { tipo: 'perguntas', tema: 'vago', perguntas: [pergunta.texto], texto: pergunta.texto },
      };
    }
  }

  const mensagemAprovada = mensagemPorId(decisao.resposta_id).texto;
  const mensagem = comporResposta({ relato: atual, decisao, mensagemAprovada });
  registrarDecisao(decisao);

  incDecisao(decisao.nivel);
  incDestino(decisao.destino);

  const limparAposEmergencia =
    decisao.nivel === 'SAMU_AGORA' ||
    decisao.nivel === 'UPA_AGORA' ||
    decisao.nivel === 'HOJE';

  return {
    estado: {
      relatos: limparAposEmergencia ? [] : relatos,
      rodadasPerguntas: 0,
      temaPergunta: undefined,
      texto_original_acumulado: limparAposEmergencia ? '' : textoAcumulado,
      fase: 'orientado',
      perguntasJaFeitas: [],
      ultimaPergunta: undefined,
    },
    resultado: { tipo: 'orientacao', texto: mensagem, decisao },
  };
}

// ============================================================
// PROCESSAR TURNO COM RELATO — interno (áudio)
// ============================================================
async function processarTurnoComRelatoInterno(
  textoRepresentativo: string,
  relatoPronto: RelatoEstruturado,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  inc('total_mensagens');

  let estado = estadoEntrada;
  let fase = estado.fase ?? 'inicio';
  if (fase === 'encerrado') {
    estado = { ...ESTADO_INICIAL, historico: estado.historico ?? [] };
    fase = 'inicio';
  }

  let perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const textoNorm = normalizarTexto(textoRepresentativo);
  const historicoFmt = formatarHistorico(estado.historico);

  // ── 0. GUARDA CRÍTICA (áudio)
  const guardaAudio = detectarCriticoRegex(textoRepresentativo);
  if (guardaAudio.critico) {
    const permitirTriagem = permiteTriagemAntes(textoRepresentativo, guardaAudio.categoria, guardaAudio.terceiro);

    if (!permitirTriagem) {
      incDecisao('SAMU_AGORA');
      incDestino('SAMU_192_PRONTO_SOCORRO');
      return respostaEmergenciaGuard(estado, guardaAudio.motivo, guardaAudio.categoria);
    }

    const perguntaCritica = perguntaTriagemCritica(guardaAudio.categoria, guardaAudio.terceiro);
    if (perguntaCritica) {
      console.log(`🟡 [guarda/áudio] triagem crítica antes: ${guardaAudio.categoria}`);
      return {
        estado: {
          ...estado,
          fase: 'coletando',
          temaPergunta: 'vago',
          rodadasPerguntas: 1,
          perguntasJaFeitas: [],
          ultimaPergunta: {
            id: `crit_${guardaAudio.categoria}`,
            campoAlvo: 'sintomas',
            texto: perguntaCritica,
          },
          texto_original_acumulado: textoRepresentativo,
        },
        resultado: {
          tipo: 'perguntas',
          tema: 'vago',
          perguntas: [perguntaCritica],
          texto: perguntaCritica,
        },
      };
    }

    incDecisao('SAMU_AGORA');
    incDestino('SAMU_192_PRONTO_SOCORRO');
    return respostaEmergenciaGuard(estado, guardaAudio.motivo, guardaAudio.categoria);
  }

  // ── 1. Confirmação
  if (fase === 'orientado' && ehConfirmacaoOrientacaoRegex(textoRepresentativo)) {
    return respostaDespedida(estado);
  }

  // ── 2. Novo caso
  if (fase === 'orientado' && ehNovoCasoRegex(textoNorm)) {
    const msg = mensagemPorId('novo_caso_001');
    return {
      estado: { ...ESTADO_INICIAL, historico: estado.historico ?? [] },
      resultado: {
        tipo: 'orientacao',
        texto: msg.texto,
        decisao: decisaoBase('novo_caso_001', 'novo_caso', ['novo caso']),
      },
    };
  }

  // ── 3. Reset pós-orientado
  if (fase === 'orientado' && estado.relatos.length > 0) {
    const pareceContinuacao =
      ehConfirmacaoOrientacaoRegex(textoRepresentativo) ||
      ehAgradecimentoRegex(textoRepresentativo) ||
      ehNovoCasoRegex(textoNorm);

    if (!pareceContinuacao) {
      console.log(`🔄 [orq/áudio] reset pós-orientado`);
      estado = { ...ESTADO_INICIAL, historico: [] };
      fase = 'inicio';
      perguntasJaFeitas = [];
    }
  }

  // ── 4. Segurança
  const nivelPre = classificarNivel(relatoPronto);
  const sinalCriticoPre = nivelPre === 'critico';

  if (!sinalCriticoPre) {
    if (ehPedidoDiagnostico(textoRepresentativo) || pedidoDiagnosticoAmplo(textoNorm)) {
      return respostaRecusaDiagnostico(estado);
    }
    if (ehPedidoMedicamento(textoRepresentativo)) {
      return respostaRecusaMedicamento(estado);
    }
  }

  // ── 5. LLM DECIDE
  const intencoes = relatoPronto.intencoes ?? [];
  const temConhecimento = intencoes.includes('conhecimento');
  const temNavegacao = intencoes.includes('navegacao');
  const temRelatoIntent = intencoes.includes('relato');
  const temSaudacaoIntent = intencoes.includes('saudacao');
  const temAgradecimentoIntent = intencoes.includes('agradecimento');
  const temOutroIntent = intencoes.includes('outro');

  const temSintoma = temSintomaClinico(relatoPronto);
  const nivelInicial = classificarNivel(relatoPronto);
  const sinalCriticoInicial = nivelInicial === 'critico';
  const perguntaRAG = relatoPronto.pergunta || textoRepresentativo;

  const llmConfiavel = intencoes.length > 0;

  // 5a. OUTRO
  if (
    llmConfiavel && temOutroIntent && !temSintoma &&
    !temConhecimento && !temNavegacao && !temRelatoIntent &&
    !temSaudacaoIntent && !temAgradecimentoIntent
  ) {
    return respostaForaEscopo(estado, true);
  }

  // 5b. SAUDAÇÃO
  if (llmConfiavel && temSaudacaoIntent && !temSintoma) {
    const r = respostaIniciaTriagem(estado, perguntasJaFeitas, textoRepresentativo);
    if (r) return r;
  }

  // 5c. AGRADECIMENTO
  if (llmConfiavel && temAgradecimentoIntent && !temSintoma) {
    return {
      estado: { ...estado, fase: 'orientado' },
      resultado: {
        tipo: 'orientacao',
        texto: mensagemPorId('encerramento_001').texto,
        decisao: decisaoBase('encerramento_001', 'agradecimento', ['encerramento']),
      },
    };
  }

  // 5d. MULTI-INTENT
  if (llmConfiavel && temConhecimento && temRelatoIntent && !sinalCriticoInicial) {
    if (perguntaTemConteudoMinimo(perguntaRAG)) {
      const temTopico = await temTopicoRelevante(perguntaRAG);
      if (temTopico) {
        const respostaBase = await responderDaBase(perguntaRAG, historicoFmt);
        if (respostaBase) {
          const cabecalho =
            respostaBase.origem === 'fallback_direto' && respostaBase.titulo
              ? `*${respostaBase.titulo}*\n\n`
              : '';
          const textoAcumuladoMI = estado.texto_original_acumulado
            ? `${estado.texto_original_acumulado} ${textoRepresentativo}`
            : textoRepresentativo;
          const relatosMI = [...estado.relatos, relatoPronto];
          const atualMI = consolidar({
            ...estado,
            relatos: relatosMI,
            texto_original_acumulado: textoAcumuladoMI,
          });
          const nivelMI = classificarNivel(atualMI);

          if (nivelMI === 'critico') {
            const decisaoCritica = aplicarMotor(atualMI, textoAcumuladoMI);
            const msgCritica = comporResposta({
              relato: atualMI,
              decisao: decisaoCritica,
              mensagemAprovada: mensagemPorId(decisaoCritica.resposta_id).texto,
            });
            registrarDecisao(decisaoCritica);
            incDecisao(decisaoCritica.nivel);
            incDestino(decisaoCritica.destino);
            const mensagemFinal = `${cabecalho}${respostaBase.corpo}\n\n---\n\n${msgCritica}`;
            return {
              estado: {
                relatos: [],
                rodadasPerguntas: 0,
                texto_original_acumulado: '',
                fase: 'orientado',
                perguntasJaFeitas: [],
                historico: estado.historico,
              },
              resultado: { tipo: 'orientacao', texto: mensagemFinal, decisao: decisaoCritica },
            };
          }

          const temaMI = escolherTemaPergunta({
            sintomas: atualMI.sintomas, idade_grupo: atualMI.idade_grupo,
            gestante: atualMI.gestante, risco_mental: atualMI.risco_mental,
            falta_de_ar: atualMI.falta_de_ar, febre: atualMI.febre,
            sinais_trauma: atualMI.sinais_trauma,
          });
          const perguntaMI = escolherProximaPergunta(temaMI, atualMI, perguntasJaFeitas);

          if (perguntaMI) {
            const mensagemFinal = `${cabecalho}${respostaBase.corpo}\n\n---\n\n${perguntaMI.texto}`;
            return {
              estado: {
                relatos: relatosMI,
                rodadasPerguntas: estado.rodadasPerguntas + 1,
                temaPergunta: temaMI,
                texto_original_acumulado: textoAcumuladoMI,
                fase: 'coletando',
                perguntasJaFeitas: [...perguntasJaFeitas, perguntaMI.id],
                ultimaPergunta: {
                  id: perguntaMI.id,
                  campoAlvo: perguntaMI.campoAlvo,
                  texto: perguntaMI.texto,
                },
                historico: estado.historico,
              },
              resultado: {
                tipo: 'orientacao',
                texto: mensagemFinal,
                decisao: decisaoBase(
                  respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento_multi',
                  'base_conhecimento_multi',
                  ['base de conhecimento', 'multi-intent'],
                ),
              },
            };
          }
        }
      }
    }
  }

  // 5e. CONHECIMENTO puro
  if (llmConfiavel && temConhecimento && !temNavegacao && !temRelatoIntent && !sinalCriticoInicial) {
    if (!perguntaTemConteudoMinimo(perguntaRAG)) {
      return respostaPerguntaVaga(estado);
    }
    const temTopico = await temTopicoRelevante(perguntaRAG);
    if (temTopico) {
      const respostaBase = await responderDaBase(perguntaRAG, historicoFmt);
      if (respostaBase) {
        const cabecalho =
          respostaBase.origem === 'fallback_direto' && respostaBase.titulo
            ? `*${respostaBase.titulo}*\n\n`
            : '';
        const rodape = respostaBase.bloqueado
          ? ''
          : '\n\n_Se tiver algum sintoma agora, é só me contar que eu te oriento onde buscar atendimento._';
        const abertura = Math.random() < 0.4 && !respostaBase.bloqueado
          ? `${escolherAleatorio(ABERTURAS_RAG)}\n\n`
          : '';
        const mensagem = `${abertura}${cabecalho}${respostaBase.corpo}${rodape}`;
        return {
          estado: { ...estado, fase: 'orientado' },
          resultado: {
            tipo: 'orientacao',
            texto: mensagem,
            decisao: decisaoBase(
              respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento',
              'base_conhecimento',
              respostaBase.bloqueado ? ['base bloqueada por segurança'] : ['base de conhecimento'],
            ),
          },
        };
      }
    }
    return respostaPerguntaVaga(estado);
  }

  // ── 6. Fallback regex (áudio)
  if (!llmConfiavel) {
    if (fase === 'orientado' && ehAgradecimentoRegex(textoRepresentativo) && !temSintoma) {
      return {
        estado: { ...estado, fase: 'orientado' },
        resultado: {
          tipo: 'orientacao',
          texto: mensagemPorId('encerramento_001').texto,
          decisao: decisaoBase('encerramento_001', 'agradecimento', ['encerramento']),
        },
      };
    }
    if (!temSintoma) {
      const faq = checarFaq(textoRepresentativo);
      if (faq) {
        return {
          estado: { ...estado, fase: 'orientado' },
          resultado: {
            tipo: 'orientacao',
            texto: faq.resposta,
            decisao: decisaoBase(faq.id, faq.id, ['faq']),
          },
        };
      }
    }
  }

  // ── 7. Mal-estar vago em áudio
  const respondendoTriagemAudio = fase === 'coletando' && !!estado.ultimaPergunta;
  if (descreveMalEstarVago(textoNorm) && estado.relatos.length === 0 && !respondendoTriagemAudio) {
    const r = respostaIniciaTriagem(estado, perguntasJaFeitas, textoRepresentativo, 'Entendi.');
    if (r) return r;
  }

  // ── 8. Áudio vazio
  if (
    !temSintoma &&
    estado.relatos.length === 0 &&
    !parecePergunta(textoRepresentativo) &&
    !descreveMalEstarVago(textoNorm) &&
    !respondendoTriagemAudio
  ) {
    return {
      estado,
      resultado: {
        tipo: 'orientacao',
        texto:
          '🎤 Ouvi seu áudio, mas não consegui identificar um sintoma específico. ' +
          'Pode me contar de novo com mais detalhes? Por exemplo: o que está sentindo, há quanto tempo e se está piorando.',
        decisao: decisaoBase('audio_vazio', 'audio_sem_conteudo', ['áudio sem sintoma']),
      },
    };
  }

  // ── 9. TRIAGEM (áudio)
  const textoAcumulado = estado.texto_original_acumulado
    ? `${estado.texto_original_acumulado} ${textoRepresentativo}`
    : textoRepresentativo;
  const relatos = [...estado.relatos, relatoPronto];
  const atual = consolidar({ ...estado, relatos, texto_original_acumulado: textoAcumulado });
  const nivelAtual = classificarNivel(atual);

  const MAX_RODADAS = 2;

  if (nivelAtual === 'normal' && estado.rodadasPerguntas < MAX_RODADAS) {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas, idade_grupo: atual.idade_grupo,
      gestante: atual.gestante, risco_mental: atual.risco_mental,
      falta_de_ar: atual.falta_de_ar, febre: atual.febre,
      sinais_trauma: atual.sinais_trauma,
    });
    const pergunta = escolherProximaPergunta(tema, atual, perguntasJaFeitas);
    if (pergunta) {
      return {
        estado: {
          relatos, rodadasPerguntas: estado.rodadasPerguntas + 1,
          temaPergunta: tema, texto_original_acumulado: textoAcumulado,
          fase: 'coletando',
          perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
          ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
        },
        resultado: { tipo: 'perguntas', tema, perguntas: [pergunta.texto], texto: pergunta.texto },
      };
    }
  }

  if (nivelAtual === 'alerta') {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas, idade_grupo: atual.idade_grupo,
      gestante: atual.gestante, risco_mental: atual.risco_mental,
      falta_de_ar: atual.falta_de_ar, febre: atual.febre,
      sinais_trauma: atual.sinais_trauma,
    });
    const pergunta = escolherProximaPergunta(tema, atual, perguntasJaFeitas);
    if (pergunta && !perguntasJaFeitas.includes(pergunta.id)) {
      return {
        estado: {
          relatos, rodadasPerguntas: estado.rodadasPerguntas + 1,
          temaPergunta: tema, texto_original_acumulado: textoAcumulado,
          fase: 'coletando',
          perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
          ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
        },
        resultado: { tipo: 'perguntas', tema, perguntas: [pergunta.texto], texto: pergunta.texto },
      };
    }
  }

  const decisao = aplicarMotor(atual, textoAcumulado);

  if (decisao.categoria_interna === 'informacao_insuficiente') {
    const pergunta = escolherProximaPergunta('vago', atual, perguntasJaFeitas);
    if (pergunta) {
      return {
        estado: {
          relatos, rodadasPerguntas: estado.rodadasPerguntas + 1,
          temaPergunta: 'vago', texto_original_acumulado: textoAcumulado,
          fase: 'coletando',
          perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
          ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
        },
        resultado: { tipo: 'perguntas', tema: 'vago', perguntas: [pergunta.texto], texto: pergunta.texto },
      };
    }
  }

  const mensagemAprovada = mensagemPorId(decisao.resposta_id).texto;
  const mensagem = comporResposta({ relato: atual, decisao, mensagemAprovada });
  registrarDecisao(decisao);

  incDecisao(decisao.nivel);
  incDestino(decisao.destino);

  const limparAposEmergenciaAudio =
    decisao.nivel === 'SAMU_AGORA' ||
    decisao.nivel === 'UPA_AGORA' ||
    decisao.nivel === 'HOJE';

  return {
    estado: {
      relatos: limparAposEmergenciaAudio ? [] : relatos,
      rodadasPerguntas: 0,
      temaPergunta: undefined,
      texto_original_acumulado: limparAposEmergenciaAudio ? '' : textoAcumulado,
      fase: 'orientado',
      perguntasJaFeitas: [],
      ultimaPergunta: undefined,
    },
    resultado: { tipo: 'orientacao', texto: mensagem, decisao },
  };
}