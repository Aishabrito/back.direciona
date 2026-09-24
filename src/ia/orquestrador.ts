// src/ia/orquestrador.ts

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

// ────────────────────────────────────────────────────
// Estado inicial
// ────────────────────────────────────────────────────
export const ESTADO_INICIAL: EstadoConversa = {
  relatos: [],
  rodadasPerguntas: 0,
  texto_original_acumulado: '',
  fase: 'inicio',
  perguntasJaFeitas: [],
  historico: [],
};

// ────────────────────────────────────────────────────
// Histórico — helpers
// ────────────────────────────────────────────────────
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
// Detecções simples
// ────────────────────────────────────────────────────
const SAUDACOES = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'opa', 'tudo bem', 'eae'];

function ehSaudacao(texto: string): boolean {
  const n = normalizarTexto(texto);
  const palavras = n.split(/\s+/).filter(Boolean);
  if (palavras.length === 0 || palavras.length > 4) return false;
  return SAUDACOES.some((s) => n === s || n.startsWith(s + ' '));
}

function ehAgradecimento(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /^(obrigad|valeu|brigad|thanks|vlw|muito obrigad)/.test(n);
}

function ehConfirmacaoOrientacao(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /^(ok|já fui|ja fui|estou indo|cheguei|obrigad|valeu|brigad|entendi|certo|beleza|blz|já chamei|ja chamei|chamei|vou (ligar|chamar)|liguei)\b/.test(n);
}

function parecePergunta(texto: string): boolean {
  if (/\?/.test(texto)) return true;
  const n = normalizarTexto(texto);
  return /\b(o que|oq|como|por que|porque|pq|quando|qdo|qnd|qual|quais|onde|kd|serve|devo|posso|pra que|me explica|explica|me fala sobre|fala sobre|significa|eh|sera)\b/.test(n);
}

function descreveQueixaPropriaRegex(textoNorm: string): boolean {
  return /\b(estou|to|tou|sinto|senti|me sinto|tenho|ando|venho)\b.{0,40}\b(com|sentindo|me sentindo|tendo|ficando)\b/.test(textoNorm);
}

function pedidoDiagnosticoAmplo(textoNorm: string): boolean {
  const DOENCAS =
    'gripe|influenza|dengue|covid|corona|coronavirus|pneumonia|infarto|avc|derrame|virose|meningite|apendicite|cancer|gastrite|sinusite|amigdalite|bronquite|asma';
  const SUSPEITA = 'acho|acredito|penso|imagino|suspeito|desconfio|sera';
  const VERBO_PROPRIO = 'estou\\s+com|to\\s+com|tou\\s+com|tenho|peguei|pega';

  if (/\bmeus?\s+sintomas?\s+(sao|e|eh|podem ser|pode ser)\b/.test(textoNorm)) return true;

  const re1 = new RegExp(`\\b(${SUSPEITA})\\s+(q|que)?\\s*(${VERBO_PROPRIO})\\b`);
  if (re1.test(textoNorm)) return true;

  const re2 = new RegExp(
    `\\b(${SUSPEITA}|deve|pode)\\s+(q|que)?\\s*((e|eh)\\s+)?\\b(${DOENCAS})\\b`,
  );
  if (re2.test(textoNorm)) return true;

  if (/\b(to|estou|tou)\s+(achando|pensando|suspeitando)\b/.test(textoNorm)) return true;

  return false;
}

// ────────────────────────────────────────────────────
// Consolidação
// ────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────
// [Task 3] Helpers de multi-intent (substituem o classificarIntencao)
// ────────────────────────────────────────────────────
function temIntent(relato: RelatoEstruturado, i: string): boolean {
  return Array.isArray(relato.intencoes) && relato.intencoes.includes(i);
}

// ============================================================
// WRAPPERS PÚBLICOS — gerenciam histórico + logging
// ============================================================

export async function processarTurno(
  textoUsuario: string,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
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
}

export async function processarTurnoComRelato(
  textoRepresentativo: string,
  relatoPronto: RelatoEstruturado,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
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

  const perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const textoNorm = normalizarTexto(textoUsuario);
  const historicoFmt = formatarHistorico(estado.historico);

  // ── 1. Confirmação pós-orientação
  if (fase === 'orientado' && ehConfirmacaoOrientacao(textoUsuario)) {
    return {
      estado: { ...estado, fase: 'encerrado' },
      resultado: {
        tipo: 'orientacao',
        texto: '💛 Fico à disposição. Cuide-se!',
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'encerramento_001', regra_acionada: 'confirmacao_orientacao',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['confirmação'],
        },
      },
    };
  }

  const respostaCurta = interpretarRespostaCurta(textoUsuario, estado.ultimaPergunta);
  const extraido = respostaCurta
    ? ({ ...RELATO_VAZIO, ...respostaCurta, texto_original_acumulado: '' } as RelatoEstruturado)
    : await interpretarRelato(textoUsuario, historicoFmt);

  // ── 2. Novo caso
  const ehNovoCaso = /\b(novo caso|outra coisa|agora e outro|mudando de assunto|deixa eu perguntar outra|outro sintoma|comecar de novo|começar de novo)\b/.test(textoNorm);

  if (fase === 'orientado' && ehNovoCaso) {
    const msg = mensagemPorId('novo_caso_001');
    return {
      estado: { ...ESTADO_INICIAL, historico: estado.historico ?? [] },
      resultado: {
        tipo: 'orientacao',
        texto: msg.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'novo_caso_001', regra_acionada: 'novo_caso',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['novo caso'],
        },
      },
    };
  }

  // ── 2.5. Bloqueio de diagnóstico ANTES do RAG
  const nivelPre = classificarNivel(extraido);
  const sinalCriticoPre = nivelPre === 'critico';

  if (
    !sinalCriticoPre &&
    !respostaCurta &&
    (ehPedidoDiagnostico(textoUsuario) || pedidoDiagnosticoAmplo(textoNorm))
  ) {
    const msg = mensagemPorId('recusa_diagnostico');
    return {
      estado,
      resultado: {
        tipo: 'orientacao', texto: msg.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'recusa_diagnostico', regra_acionada: 'bloqueio_diagnostico',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['bloqueio'],
        },
      },
    };
  }

  // ── 3. MULTI-INTENT — lê direto de extraido.intencoes
  const temConhecimento = temIntent(extraido, 'conhecimento');
  const temRelatoIntent = temIntent(extraido, 'relato');
  const temNavegacao = temIntent(extraido, 'navegacao');

  const relatoComoQueixa =
    temRelatoIntent || descreveQueixaPropriaRegex(textoNorm);

  const nivelInicial = classificarNivel(extraido);
  const sinalCriticoInicial = nivelInicial === 'critico';

  const perguntaRAG = extraido.pergunta || textoUsuario;

  // 3a. Conhecimento puro (sem relato) → RAG
  if (
    temConhecimento &&
    !temNavegacao &&
    !temRelatoIntent &&
    !sinalCriticoInicial &&
    !respostaCurta
  ) {
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
        const mensagem = `${cabecalho}${respostaBase.corpo}${rodape}`;

        return {
          estado: { ...estado, fase: 'orientado' },
          resultado: {
            tipo: 'orientacao',
            texto: mensagem,
            decisao: {
              categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
              resposta_id: respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento',
              regra_acionada: 'base_conhecimento',
              versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR',
              motivos: respostaBase.bloqueado
                ? ['base bloqueada por segurança']
                : ['base de conhecimento'],
            },
          },
        };
      }
    }
  }

  // 3b. Multi-intent: conhecimento + relato → responde pergunta E inicia triagem
  if (
    temConhecimento &&
    temRelatoIntent &&
    !sinalCriticoInicial &&
    !respostaCurta
  ) {
    const temTopico = await temTopicoRelevante(perguntaRAG);
    if (temTopico) {
      const respostaBase = await responderDaBase(perguntaRAG, historicoFmt);
      if (respostaBase) {
        const cabecalho =
          respostaBase.origem === 'fallback_direto' && respostaBase.titulo
            ? `*${respostaBase.titulo}*\n\n`
            : '';
        const rodape = respostaBase.bloqueado
          ? '\n\n_Sobre o que você mencionou, me conta mais: desde quando começou?_'
          : '\n\n_Sobre o que você mencionou, me conta mais: desde quando começou e se está piorando?_';
        const mensagem = `${cabecalho}${respostaBase.corpo}${rodape}`;

        const textoAcumuladoMI = estado.texto_original_acumulado
          ? `${estado.texto_original_acumulado} ${textoUsuario}`
          : textoUsuario;
        const relatosMI = [...estado.relatos, extraido];

        return {
          estado: {
            ...estado,
            relatos: relatosMI,
            texto_original_acumulado: textoAcumuladoMI,
            fase: 'coletando',
          },
          resultado: {
            tipo: 'orientacao',
            texto: mensagem,
            decisao: {
              categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
              resposta_id: respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento_multi',
              regra_acionada: 'base_conhecimento_multi',
              versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR',
              motivos: respostaBase.bloqueado
                ? ['base bloqueada por segurança', 'multi-intent']
                : ['base de conhecimento', 'multi-intent'],
            },
          },
        };
      }
    }
  }

  // ── 4. Agradecimento
  if (fase === 'orientado' && ehAgradecimento(textoUsuario) && !temSintomaClinico(extraido)) {
    return {
      estado: { ...estado, fase: 'orientado' },
      resultado: {
        tipo: 'orientacao',
        texto: mensagemPorId('encerramento_001').texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'encerramento_001', regra_acionada: 'agradecimento',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['encerramento'],
        },
      },
    };
  }

  const nivel = classificarNivel(extraido);
  const sinalCritico = nivel === 'critico';

  // ── 5. FAQ
  if (!temSintomaClinico(extraido) && !respostaCurta) {
    const faqEncontrada = checarFaq(textoUsuario);
    if (faqEncontrada) {
      return {
        estado: { ...estado, fase: 'orientado' },
        resultado: {
          tipo: 'orientacao',
          texto: faqEncontrada.resposta,
          decisao: {
            categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
            resposta_id: faqEncontrada.id, regra_acionada: faqEncontrada.id,
            versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['faq'],
          },
        },
      };
    }
  }

  // ── 6. Bloqueio de medicamento
  if (!sinalCritico && ehPedidoMedicamento(textoUsuario)) {
    const msg = mensagemPorId('recusa_medicamento');
    return {
      estado,
      resultado: {
        tipo: 'orientacao', texto: msg.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'recusa_medicamento', regra_acionada: 'bloqueio_medicamento',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['bloqueio'],
        },
      },
    };
  }

  // ── 7. Saudação inicial
  if (
    estado.relatos.length === 0 &&
    ehSaudacao(textoUsuario) &&
    !temSintomaClinico(extraido) &&
    !respostaCurta
  ) {
    const pergunta = escolherProximaPergunta('vago', RELATO_VAZIO, perguntasJaFeitas);
    if (!pergunta) {
      return {
        estado, resultado: {
          tipo: 'orientacao', texto: 'Como posso ajudar?',
          decisao: {
            categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
            resposta_id: 'vago', regra_acionada: 'vago', versao_regras: VERSAO_REGRAS,
            nivel: 'AGENDAR', motivos: [],
          },
        },
      };
    }
    return {
      estado: {
        ...estado, fase: 'coletando', temaPergunta: 'vago',
        rodadasPerguntas: 1,
        perguntasJaFeitas: [...perguntasJaFeitas, pergunta.id],
        ultimaPergunta: { id: pergunta.id, campoAlvo: pergunta.campoAlvo, texto: pergunta.texto },
        texto_original_acumulado: textoUsuario,
      },
      resultado: { tipo: 'perguntas', tema: 'vago', perguntas: [pergunta.texto], texto: pergunta.texto },
    };
  }

  // ── 8. Reset de contexto
  const nadaClinico =
    !temSintomaClinico(extraido) &&
    !parecePergunta(textoUsuario) &&
    !relatoComoQueixa &&
    !respostaCurta;

  if (nadaClinico) {
    const msgForaEscopo = mensagemPorId('fora_escopo_001');
    return {
      estado: { ...ESTADO_INICIAL, historico: estado.historico ?? [] },
      resultado: {
        tipo: 'orientacao', texto: msgForaEscopo.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'fora_escopo_001', regra_acionada: 'fora_do_escopo_reset',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['fora de escopo'],
        },
      },
    };
  }

  // ── 9. Fora de escopo inicial
  if (
    !temSintomaClinico(extraido) &&
    !relatoComoQueixa &&
    estado.relatos.length === 0 &&
    !respostaCurta
  ) {
    const msgForaEscopo = mensagemPorId('fora_escopo_001');
    return {
      estado,
      resultado: {
        tipo: 'orientacao', texto: msgForaEscopo.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'fora_escopo_001', regra_acionada: 'fora_do_escopo_inicial',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['fora de escopo'],
        },
      },
    };
  }

  // ── 10. Consolida relato (triagem normal)
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

  return {
    estado: {
      relatos,
      rodadasPerguntas: 0,
      temaPergunta: undefined,
      texto_original_acumulado: textoAcumulado,
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

  const perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const textoNorm = normalizarTexto(textoRepresentativo);
  const historicoFmt = formatarHistorico(estado.historico);

  if (fase === 'orientado' && ehConfirmacaoOrientacao(textoRepresentativo)) {
    return {
      estado: { ...estado, fase: 'encerrado' },
      resultado: {
        tipo: 'orientacao',
        texto: '💛 Fico à disposição. Cuide-se!',
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'encerramento_001', regra_acionada: 'confirmacao_orientacao',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['confirmação'],
        },
      },
    };
  }

  if (fase === 'orientado' && ehAgradecimento(textoRepresentativo) && !temSintomaClinico(relatoPronto)) {
    return {
      estado: { ...estado, fase: 'orientado' },
      resultado: {
        tipo: 'orientacao',
        texto: mensagemPorId('encerramento_001').texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'encerramento_001', regra_acionada: 'agradecimento',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['encerramento'],
        },
      },
    };
  }

  // ── 2.5. Bloqueio de diagnóstico
  const nivelPre = classificarNivel(relatoPronto);
  const sinalCriticoPre = nivelPre === 'critico';

  if (
    !sinalCriticoPre &&
    (ehPedidoDiagnostico(textoRepresentativo) || pedidoDiagnosticoAmplo(textoNorm))
  ) {
    const msg = mensagemPorId('recusa_diagnostico');
    return {
      estado,
      resultado: {
        tipo: 'orientacao', texto: msg.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'recusa_diagnostico', regra_acionada: 'bloqueio_diagnostico',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['bloqueio'],
        },
      },
    };
  }

  // ── 3. MULTI-INTENT (áudio)
  const temConhecimento = temIntent(relatoPronto, 'conhecimento');
  const temRelatoIntent = temIntent(relatoPronto, 'relato');
  const temNavegacao = temIntent(relatoPronto, 'navegacao');

  const relatoComoQueixa =
    temRelatoIntent || descreveQueixaPropriaRegex(textoNorm);
  const nivelInicial = classificarNivel(relatoPronto);
  const sinalCriticoInicial = nivelInicial === 'critico';
  const perguntaRAG = relatoPronto.pergunta || textoRepresentativo;

  if (
    temConhecimento &&
    !temNavegacao &&
    !temRelatoIntent &&
    !sinalCriticoInicial
  ) {
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
        const mensagem = `${cabecalho}${respostaBase.corpo}${rodape}`;

        return {
          estado: { ...estado, fase: 'orientado' },
          resultado: {
            tipo: 'orientacao',
            texto: mensagem,
            decisao: {
              categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
              resposta_id: respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento',
              regra_acionada: 'base_conhecimento',
              versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR',
              motivos: respostaBase.bloqueado
                ? ['base bloqueada por segurança']
                : ['base de conhecimento'],
            },
          },
        };
      }
    }
  }

  if (temConhecimento && temRelatoIntent && !sinalCriticoInicial) {
    const temTopico = await temTopicoRelevante(perguntaRAG);
    if (temTopico) {
      const respostaBase = await responderDaBase(perguntaRAG, historicoFmt);
      if (respostaBase) {
        const cabecalho =
          respostaBase.origem === 'fallback_direto' && respostaBase.titulo
            ? `*${respostaBase.titulo}*\n\n`
            : '';
        const rodape = '\n\n_Sobre o que você mencionou, me conta mais: desde quando começou e se está piorando?_';
        const mensagem = `${cabecalho}${respostaBase.corpo}${rodape}`;

        const textoAcumuladoMI = estado.texto_original_acumulado
          ? `${estado.texto_original_acumulado} ${textoRepresentativo}`
          : textoRepresentativo;
        const relatosMI = [...estado.relatos, relatoPronto];

        return {
          estado: {
            ...estado,
            relatos: relatosMI,
            texto_original_acumulado: textoAcumuladoMI,
            fase: 'coletando',
          },
          resultado: {
            tipo: 'orientacao',
            texto: mensagem,
            decisao: {
              categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
              resposta_id: respostaBase.bloqueado ? 'base_bloqueada' : 'base_conhecimento_multi',
              regra_acionada: 'base_conhecimento_multi',
              versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR',
              motivos: respostaBase.bloqueado
                ? ['base bloqueada por segurança', 'multi-intent']
                : ['base de conhecimento', 'multi-intent'],
            },
          },
        };
      }
    }
  }

  if (!temSintomaClinico(relatoPronto) && estado.relatos.length === 0 && !parecePergunta(textoRepresentativo)) {
    return {
      estado,
      resultado: {
        tipo: 'orientacao',
        texto:
          '🎤 Ouvi seu áudio, mas não consegui identificar um sintoma específico. ' +
          'Pode me contar de novo com mais detalhes? Por exemplo: o que está sentindo, há quanto tempo e se está piorando.',
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'audio_vazio', regra_acionada: 'audio_sem_conteudo',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['áudio sem sintoma'],
        },
      },
    };
  }

  const nivel = classificarNivel(relatoPronto);
  const sinalCritico = nivel === 'critico';

  if (!temSintomaClinico(relatoPronto)) {
    const faq = checarFaq(textoRepresentativo);
    if (faq) {
      return {
        estado: { ...estado, fase: 'orientado' },
        resultado: {
          tipo: 'orientacao', texto: faq.resposta,
          decisao: {
            categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
            resposta_id: faq.id, regra_acionada: faq.id,
            versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['faq'],
          },
        },
      };
    }
  }

  if (!sinalCritico && ehPedidoMedicamento(textoRepresentativo)) {
    const msg = mensagemPorId('recusa_medicamento');
    return {
      estado,
      resultado: {
        tipo: 'orientacao', texto: msg.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
          resposta_id: 'recusa_medicamento', regra_acionada: 'bloqueio_medicamento',
          versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['bloqueio'],
        },
      },
    };
  }

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

  return {
    estado: {
      relatos, rodadasPerguntas: 0, temaPergunta: undefined,
      texto_original_acumulado: textoAcumulado,
      fase: 'orientado', perguntasJaFeitas: [], ultimaPergunta: undefined,
    },
    resultado: { tipo: 'orientacao', texto: mensagem, decisao },
  };
}