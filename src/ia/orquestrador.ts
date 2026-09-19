import { registrarDecisao } from './auditoria.js';
import { interpretarRelato } from './extrator_de_informacoes.js';
import {
  mensagemPorId,
  ehPedidoDiagnostico,
  ehPedidoMedicamento,
} from './mensagens.js';
import { aplicarMotor } from './motor_de_regras.js';
import {
  escolherTemaPergunta, escolherProximaPergunta,
  interpretarRespostaCurta, type TemaPergunta,
} from './perguntas.js';
import { checarFaq } from './faq.js';
import { comporResposta } from './compositor_mensagem.js';
import {
  RELATO_VAZIO, VERSAO_REGRAS,
  type EstadoConversa, type RelatoEstruturado, type TurnoResultado,
} from './tipos.js';
import { mesclarRelatos } from './validador_de_saida.js';
import { normalizarTexto } from './normalizar.js';

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
    (relato.sinais_neurologicos || []).length > 0
  );
}

type NivelAlerta = 'critico' | 'alerta' | 'normal';

function classificarNivel(relato: RelatoEstruturado): NivelAlerta {
  // CRÍTICO
  if (relato.risco_mental === 'iminente') return 'critico';
  if ((relato.sinais_alerta || []).includes('violencia_sexual')) return 'critico';
  if ((relato.sinais_alerta || []).includes('violencia_domestica')) return 'critico';
  if ((relato.sinais_neurologicos || []).length > 0) return 'critico';
  if ((relato.sinais_trauma || []).includes('ferimento_perfurante')) return 'critico';
  if (relato.autodiagnostico_grave) return 'critico';
  if (relato.alergia_grave === true) return 'critico';
  if (relato.falta_de_ar === true && (relato.fala_frases === false || relato.labios_roxos === true)) return 'critico';
  if (relato.dor_no_peito === true && (relato.falta_de_ar === true || relato.desmaio === true || relato.confusao === true)) return 'critico';
  if (relato.desmaio === true && relato.confusao === true) return 'critico';
  if ((relato.sinais_obstetricos || []).length > 0) return 'critico';
  if (relato.idade_grupo === 'bebe' && relato.febre === true) return 'critico';
  if (relato.idade_grupo === 'idoso' && relato.trauma === true && (relato.confusao === true || relato.desmaio === true)) return 'critico';

  // ALERTA — faz 1 pergunta e decide
  if (relato.falta_de_ar === true && relato.fala_frases === 'nao_informado' && relato.labios_roxos === 'nao_informado') return 'alerta';
  if ((relato.sinais_trauma || []).some((s) => ['trauma_automobilistico', 'queda_altura', 'trauma_craniano'].includes(s))) return 'alerta';
  if (relato.dor_no_peito === true && relato.falta_de_ar !== true) return 'alerta';
  if (relato.sangramento === true) return 'alerta';
  if (relato.confusao === true) return 'alerta';

  return 'normal';
}

// ============================================================
// PROCESSAR TURNO — texto normal
// ============================================================
export async function processarTurno(
  textoUsuario: string,
  estado: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  const perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const fase = estado.fase ?? 'inicio';

  const respostaCurta = interpretarRespostaCurta(textoUsuario, estado.ultimaPergunta);
  const extraido = respostaCurta
    ? ({ ...RELATO_VAZIO, ...respostaCurta, texto_original_acumulado: '' } as RelatoEstruturado)
    : await interpretarRelato(textoUsuario);

  // ============================================================
  // 1. Detecção de novo caso (zera o contexto)
  // ============================================================
  const textoNorm = normalizarTexto(textoUsuario);
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

  // ============================================================
  // 2. Agradecimento em fase orientado → encerramento
  // ============================================================
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

  // ============================================================
  // 3. FAQ — só se não tem sintoma clínico
  // ============================================================
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

  // ============================================================
  // 4. Bloqueios de escopo (só se não for crítico)
  // ============================================================
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

  // ============================================================
  // 5. Saudação inicial SEM sintoma
  // ============================================================
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

  // ============================================================
  // 6. Fora de escopo
  // ============================================================
  if (
    !temSintomaClinico(extraido) &&
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

  // ============================================================
  // 7. Consolida relato
  // ============================================================
  const textoAcumulado = estado.texto_original_acumulado
    ? `${estado.texto_original_acumulado} ${textoUsuario}`
    : textoUsuario;

  const relatos = [...estado.relatos, extraido];
  const atual = consolidar({ ...estado, relatos, texto_original_acumulado: textoAcumulado });
  const nivelAtual = classificarNivel(atual);

  const MAX_RODADAS = 2;

  // ============================================================
  // 8. Refinamento (nível normal)
  // ============================================================
  if (nivelAtual === 'normal' && estado.rodadasPerguntas < MAX_RODADAS) {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas, idade_grupo: atual.idade_grupo,
      gestante: atual.gestante, risco_mental: atual.risco_mental,
      falta_de_ar: atual.falta_de_ar, febre: atual.febre,
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

  // ============================================================
  // 9. Alerta — uma pergunta crítica se faltar
  // ============================================================
  if (nivelAtual === 'alerta') {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas, idade_grupo: atual.idade_grupo,
      gestante: atual.gestante, risco_mental: atual.risco_mental,
      falta_de_ar: atual.falta_de_ar, febre: atual.febre,
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

  // ============================================================
  // 10. Decisão pelo motor
  // ============================================================
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

  // [NOVO] Compositor de resposta em blocos
  const mensagemAprovada = mensagemPorId(decisao.resposta_id).texto;
  const mensagem = comporResposta({ relato: atual, decisao, mensagemAprovada });
  registrarDecisao(decisao);

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
  estado: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  const perguntasJaFeitas = estado.perguntasJaFeitas ?? [];
  const fase = estado.fase ?? 'inicio';

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

  // Áudio vazio / sem sintoma
  if (!temSintomaClinico(relatoPronto) && estado.relatos.length === 0) {
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

  const sinalCritico = classificarNivel(relatoPronto) === 'critico';

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

  return {
    estado: {
      relatos, rodadasPerguntas: 0, temaPergunta: undefined,
      texto_original_acumulado: textoAcumulado,
      fase: 'orientado', perguntasJaFeitas: [], ultimaPergunta: undefined,
    },
    resultado: { tipo: 'orientacao', texto: mensagem, decisao },
  };
}