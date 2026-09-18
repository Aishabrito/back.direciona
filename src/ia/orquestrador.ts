
import { registrarDecisao } from './auditoria.js';
import { interpretarRelato } from './extrator_de_informacoes.js';
import {
  sanitizarResposta,
  mensagemPorId,
  ehPedidoDiagnostico,
  ehPedidoMedicamento,
} from './mensagens.js';
import { aplicarMotor } from './motor_de_regras.js';
import { escolherTemaPergunta, PERGUNTAS } from './perguntas.js';
import { checarFaq } from './faq.js';
import {
  RELATO_VAZIO,
  VERSAO_REGRAS,
  type EstadoConversa,
  type RelatoEstruturado,
  type TurnoResultado,
} from './tipos.js';
import { mesclarRelatos } from './validador_de_saida.js';
import { normalizarTexto } from './normalizar.js';

export const ESTADO_INICIAL: EstadoConversa = {
  relatos: [],
  rodadasPerguntas: 0,
  texto_original_acumulado: '',
};

// [FIX 12] detecta saudação inicial para não responder "fora do escopo"
const SAUDACOES_INICIAIS = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'opa', 'tudo bem'];
function ehSaudacaoInicial(texto: string): boolean {
  const n = normalizarTexto(texto);
  const palavras = n.split(/\s+/).filter(Boolean);
  if (palavras.length === 0 || palavras.length > 4) return false;
  return SAUDACOES_INICIAIS.some((s) => n === s || n.startsWith(s + ' '));
}

function consolidar(estado: EstadoConversa): RelatoEstruturado {
  const base = estado.relatos.reduce((acc, item) => mesclarRelatos(acc, item), { ...RELATO_VAZIO });
  return { ...base, texto_original_acumulado: estado.texto_original_acumulado || '' };
}

function precisaPerguntar(relato: RelatoEstruturado): boolean {
  if (relato.sinais_alerta.length > 0) return false;
  if (relato.sinais_obstetricos && relato.sinais_obstetricos.length > 0) return false;
  if (relato.sinais_trauma && relato.sinais_trauma.length > 0) return false;
  if (relato.risco_mental === 'iminente') return false;
  if (relato.informacao_insuficiente) return true;

  if (relato.sintomas.length > 0) {
    const semDuracao = relato.duracao === 'nao_informado';
    const temQueixaIntermediaria =
      relato.febre === true ||
      relato.vomitos === true ||
      relato.sintomas.some((s) => /dor|febre|tosse|resfriado|enjoo|queimadura|queda|ferida/i.test(s));
    if (semDuracao || temQueixaIntermediaria) return true;
  }
  return false;
}

export async function processarTurno(
  textoUsuario: string,
  estado: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  // 1. FAQ institucional
  const faqEncontrada = checarFaq(textoUsuario);
  if (faqEncontrada) {
    return {
      estado,
      resultado: {
        tipo: 'orientacao',
        texto: faqEncontrada.resposta,
        decisao: {
          categoria_interna: 'fora_do_escopo',
          destino: 'FALLBACK',
          resposta_id: faqEncontrada.id,
          regra_acionada: faqEncontrada.id,
          versao_regras: VERSAO_REGRAS,
        },
      },
    };
  }

  // 2. Pedido de medicamento
  if (ehPedidoMedicamento(textoUsuario)) {
    const msg = mensagemPorId('recusa_medicamento');
    return {
      estado,
      resultado: {
        tipo: 'orientacao',
        texto: msg.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo',
          destino: 'FALLBACK',
          resposta_id: 'recusa_medicamento',
          regra_acionada: 'bloqueio_medicamento',
          versao_regras: VERSAO_REGRAS,
        },
      },
    };
  }

  // 3. Pedido de diagnóstico
  if (ehPedidoDiagnostico(textoUsuario)) {
    const msg = mensagemPorId('recusa_diagnostico');
    return {
      estado,
      resultado: {
        tipo: 'orientacao',
        texto: msg.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo',
          destino: 'FALLBACK',
          resposta_id: 'recusa_diagnostico',
          regra_acionada: 'bloqueio_diagnostico',
          versao_regras: VERSAO_REGRAS,
        },
      },
    };
  }

  // [FIX 12] saudação inicial → pergunta de triagem em vez de "fora do escopo"
  if (estado.relatos.length === 0 && ehSaudacaoInicial(textoUsuario)) {
    const perguntas = PERGUNTAS.vago;
    return {
      estado: {
        relatos: [],
        rodadasPerguntas: 1,
        temaPergunta: 'vago',
        texto_original_acumulado: textoUsuario,
      },
      resultado: {
        tipo: 'perguntas',
        tema: 'vago',
        perguntas,
        texto: perguntas.join('\n'),
      },
    };
  }

  // 4. Extração clínica
  const textoAcumulado = estado.texto_original_acumulado
    ? `${estado.texto_original_acumulado} ${textoUsuario}`
    : textoUsuario;

  const extraido = await interpretarRelato(textoUsuario);

  // 5. Fora de escopo (mensagem sem conteúdo clínico na primeira interação)
  const semSintomasOuSinais =
    extraido.informacao_insuficiente === true &&
    extraido.sintomas.length === 0 &&
    extraido.sinais_alerta.length === 0 &&
    extraido.risco_mental === 'nao_mencionado';

  if (semSintomasOuSinais && estado.relatos.length === 0) {
    const msgForaEscopo = mensagemPorId('fora_escopo_001');
    return {
      estado,
      resultado: {
        tipo: 'orientacao',
        texto: msgForaEscopo.texto,
        decisao: {
          categoria_interna: 'fora_do_escopo',
          destino: 'FALLBACK',
          resposta_id: 'fora_escopo_001',
          regra_acionada: 'fora_do_escopo_inicial',
          versao_regras: VERSAO_REGRAS,
        },
      },
    };
  }

  const relatos = [...estado.relatos, extraido];
  const atual = consolidar({ ...estado, relatos, texto_original_acumulado: textoAcumulado });

  // 6. Linha vermelha
  const emergenciaImediata =
    atual.risco_mental === 'iminente' ||
    (atual.idade_grupo === 'bebe' && atual.febre === true) ||
    (atual.trauma === true && (atual.confusao === true || atual.desmaio === true)) ||
    (atual.dor_no_peito === true &&
      (atual.falta_de_ar === true || atual.desmaio === true || atual.confusao === true)) ||
    atual.desmaio === true ||
    (atual.sinais_obstetricos && atual.sinais_obstetricos.length > 0) ||
    (atual.sinais_trauma && atual.sinais_trauma.length > 0);

  // 7. Rodada única de refinamento
  if (!emergenciaImediata && estado.rodadasPerguntas < 1 && precisaPerguntar(atual)) {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas,
      idade_grupo: atual.idade_grupo,
      gestante: atual.gestante,
      risco_mental: atual.risco_mental,
      falta_de_ar: atual.falta_de_ar,
      febre: atual.febre,
    });
    const perguntas = PERGUNTAS[tema] || PERGUNTAS.vago;

    return {
      estado: {
        relatos,
        rodadasPerguntas: estado.rodadasPerguntas + 1,
        temaPergunta: tema,
        texto_original_acumulado: textoAcumulado,
      },
      resultado: { tipo: 'perguntas', tema, perguntas, texto: perguntas.join('\n') },
    };
  }

  // 8. Motor de regras
  const decisao = aplicarMotor(atual, textoAcumulado);

  if (decisao.categoria_interna === 'informacao_insuficiente' && estado.rodadasPerguntas < 1) {
    const perguntas = PERGUNTAS.vago;
    return {
      estado: {
        relatos,
        rodadasPerguntas: estado.rodadasPerguntas + 1,
        temaPergunta: 'vago',
        texto_original_acumulado: textoAcumulado,
      },
      resultado: { tipo: 'perguntas', tema: 'vago', perguntas, texto: perguntas.join('\n') },
    };
  }

  const mensagem = sanitizarResposta(mensagemPorId(decisao.resposta_id).texto, decisao.resposta_id);
  registrarDecisao(decisao);

  return {
    estado: {
      relatos,
      rodadasPerguntas: 0,
      temaPergunta: undefined,
      texto_original_acumulado: textoAcumulado,
    },
    resultado: { tipo: 'orientacao', texto: mensagem, decisao },
  };
}