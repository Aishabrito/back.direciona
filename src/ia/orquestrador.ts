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
} from './tipos.js';
import { mesclarRelatos } from './validador_de_saida.js';
import { normalizarTexto } from './normalizar.js';
import { inc, incDecisao, incDestino } from '../servicos/metricas.js';

export const ESTADO_INICIAL: EstadoConversa = {
  relatos: [],
  rodadasPerguntas: 0,
  texto_original_acumulado: '',
  fase: 'inicio',
  perguntasJaFeitas: [],
};

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

// Detecta pergunta com tolerância a abreviações comuns no WhatsApp.
// Mantida pra uso interno (ex: detectar "isso é pergunta?" em blocos genéricos).
function parecePergunta(texto: string): boolean {
  if (/\?/.test(texto)) return true;
  const n = normalizarTexto(texto);
  return /\b(o que|oq|como|por que|porque|pq|quando|qdo|qnd|qual|quais|onde|kd|serve|devo|posso|pra que|me explica|explica|me fala sobre|fala sobre|significa|eh|sera)\b/.test(n);
}

// [FIX] Pergunta de CONHECIMENTO → vai pro RAG.
// Só dispara pra perguntas educativas ("o que é X", "como funciona Y").
function ehPerguntaConhecimento(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /\b(o que (e|eh|sao)|oq (e|eh|sao)|como funciona|para que serve|pra que serve|qual a diferenca|diferenca entre|o que significa|significa|quantos? graus|quantos? dias|quanto tempo|como se pega|como evita|como prevenir|tem cura|o que causa|me explica|me explica o que|explica|me fala sobre|fala sobre)\b/.test(n);
}

// [FIX] Pergunta de NAVEGAÇÃO → vai pro motor de regras (triagem).
// "Para onde vou", "onde devo ir", "o que faço" — pedido de encaminhamento.
function ehPerguntaNavegacao(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /\b(para onde|pra onde|onde (eu )?(vou|devo ir|procuro|busco)|o que (eu )?(faco|devo fazer)|qual (o )?(servico|unidade)|aonde|me indica (um|uma)|onde (tem|fica)|devo ir|preciso ir)\b/.test(n);
}

// Detecta se a pessoa descreve uma queixa em 1ª pessoa:
// "estou com X", "sinto Y", "to com Z". Usado pra separar pergunta de relato.
function descreveQueixaPropriaRegex(textoNorm: string): boolean {
  return /\b(estou|to|tou|sinto|senti|me sinto|tenho|ando|venho)\b.{0,40}\b(com|sentindo|me sentindo|tendo|ficando)\b/.test(textoNorm);
}

// ============================================================
// PROCESSAR TURNO — texto normal
// ============================================================
export async function processarTurno(
  textoUsuario: string,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  inc('total_mensagens');

  // [FIX] Conversa encerrada → qualquer mensagem nova começa ciclo limpo.
  // Sem isso, "para onde vou..." depois de um encerramento herdava relatos antigos.
  let estado = estadoEntrada;
  let fase = estado.fase ?? 'inicio';
  if (fase === 'encerrado') {
    estado = { ...ESTADO_INICIAL };
    fase = 'inicio';
  }

  const perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const textoNorm = normalizarTexto(textoUsuario);

  // ── 1. Confirmação pós-orientação → encerramento amigável
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
    : await interpretarRelato(textoUsuario);

  // ── 2. Detecção de novo caso (zera o contexto)
  const ehNovoCaso = /\b(novo caso|outra coisa|agora e outro|mudando de assunto|deixa eu perguntar outra|outro sintoma|comecar de novo|começar de novo)\b/.test(textoNorm);

  if (fase === 'orientado' && ehNovoCaso) {
    const msg = mensagemPorId('novo_caso_001');
    return {
      estado: { ...ESTADO_INICIAL },
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

  // ── 3. BASE DE CONHECIMENTO — só pra perguntas de CONHECIMENTO.
  // [FIX] "Para onde eu vou..." é navegação → cai no motor de regras.
  // Pergunta educativa ("oq eh dengue") → RAG.
  const ehConhecimento = ehPerguntaConhecimento(textoUsuario);
  const ehNavegacao = ehPerguntaNavegacao(textoUsuario);
  const relatoComoQueixa = descreveQueixaPropriaRegex(textoNorm);

  const nivelInicial = classificarNivel(extraido);
  const sinalCriticoInicial = nivelInicial === 'critico';

  if (ehConhecimento && !ehNavegacao && !relatoComoQueixa && !sinalCriticoInicial && !respostaCurta) {
    const temTopico = await temTopicoRelevante(textoUsuario);
    if (temTopico) {
      const respostaBase = await responderDaBase(textoUsuario);
      if (respostaBase) {
        // [FIX] monta a mensagem em template — corpo já passou pelo judge
        const cabecalho = respostaBase.titulo ? `*${respostaBase.titulo}*\n\n` : '';
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
              motivos: respostaBase.bloqueado ? ['base bloqueada por segurança'] : ['base de conhecimento'],
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

  // ── 5. FAQ — só se não tem sintoma clínico
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

  // ── 6. Bloqueios de escopo
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
  if (!sinalCritico && ehPedidoDiagnostico(textoUsuario)) {
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

  // ── 7. Saudação inicial SEM sintoma
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

  // ── 8. Reset de contexto: mensagem sem nada clínico e não-pergunta
  const nadaClinico =
    !temSintomaClinico(extraido) &&
    !parecePergunta(textoUsuario) &&
    !relatoComoQueixa &&
    !respostaCurta;

  if (nadaClinico) {
    const msgForaEscopo = mensagemPorId('fora_escopo_001');
    return {
      estado: { ...ESTADO_INICIAL },
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

  // ── 9. Fora de escopo (primeira interação)
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

  // ── 10. Consolida relato
  const textoAcumulado = estado.texto_original_acumulado
    ? `${estado.texto_original_acumulado} ${textoUsuario}`
    : textoUsuario;

  const relatos = [...estado.relatos, extraido];
  const atual = consolidar({ ...estado, relatos, texto_original_acumulado: textoAcumulado });
  const nivelAtual = classificarNivel(atual);

  const MAX_RODADAS = 2;

  // Refinamento (nível normal)
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

  // Alerta — uma pergunta crítica se faltar
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

  // Decisão pelo motor
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
// PROCESSAR TURNO COM RELATO PRONTO — quando veio de áudio
// ============================================================
export async function processarTurnoComRelato(
  textoRepresentativo: string,
  relatoPronto: RelatoEstruturado,
  estadoEntrada: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  inc('total_mensagens');

  // [FIX] Mesmo reset do fluxo de texto.
  let estado = estadoEntrada;
  let fase = estado.fase ?? 'inicio';
  if (fase === 'encerrado') {
    estado = { ...ESTADO_INICIAL };
    fase = 'inicio';
  }

  const perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const textoNorm = normalizarTexto(textoRepresentativo);

  // Confirmação pós-orientação
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

  // Agradecimento
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

  // [FIX] Base de conhecimento — mesmo filtro do fluxo de texto:
  // só dispara pra pergunta de conhecimento pura, nunca pra navegação.
  const ehConhecimento = ehPerguntaConhecimento(textoRepresentativo);
  const ehNavegacao = ehPerguntaNavegacao(textoRepresentativo);
  const relatoComoQueixa = descreveQueixaPropriaRegex(textoNorm);
  const nivelInicial = classificarNivel(relatoPronto);
  const sinalCriticoInicial = nivelInicial === 'critico';

  if (
    ehConhecimento &&
    !ehNavegacao &&
    !relatoComoQueixa &&
    !sinalCriticoInicial
  ) {
    const temTopico = await temTopicoRelevante(textoRepresentativo);
    if (temTopico) {
      const respostaBase = await responderDaBase(textoRepresentativo);
      if (respostaBase) {
        return {
          estado: { ...estado, fase: 'orientado' },
          resultado: {
            tipo: 'orientacao',
            texto: `${respostaBase}\n\n_Se tiver algum sintoma agora, é só me contar que eu te oriento onde buscar atendimento._`,
            decisao: {
              categoria_interna: 'fora_do_escopo', destino: 'FALLBACK',
              resposta_id: 'base_conhecimento', regra_acionada: 'base_conhecimento',
              versao_regras: VERSAO_REGRAS, nivel: 'AGENDAR', motivos: ['base de conhecimento'],
            },
          },
        };
      }
    }
  }

  // Áudio vazio / sem sintoma
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

  // FAQ — só se não tem sintoma
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

  // Bloqueios
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
  if (!sinalCritico && ehPedidoDiagnostico(textoRepresentativo)) {
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