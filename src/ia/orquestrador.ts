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

const SAUDACOES_INICIAIS = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'opa', 'tudo bem', 'eae'];

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

// [MELHORIA] Detecção de sinal vermelho mais completa
function temSinalVermelho(relato: RelatoEstruturado): boolean {
  return (
    relato.sinais_alerta.length > 0 ||
    relato.falta_de_ar === true ||
    relato.dor_no_peito === true ||
    relato.desmaio === true ||
    relato.confusao === true ||
    relato.risco_mental === 'iminente' ||
    (relato.sinais_obstetricos && relato.sinais_obstetricos.length > 0) ||
    (relato.sinais_trauma && relato.sinais_trauma.length > 0) ||
    (relato.idade_grupo === 'bebe' && relato.febre === true)
  );
}

// [MELHORIA] Precisa perguntar com mais nuances
function precisaPerguntar(relato: RelatoEstruturado, rodadas: number): boolean {
  if (rodadas >= 2) return false; // máximo 2 rodadas
  if (temSinalVermelho(relato)) return false;

  if (relato.informacao_insuficiente) return true;

  if (relato.sintomas.length > 0) {
    const semDuracao = relato.duracao === 'nao_informado';
    const semIntensidade = relato.intensidade === 'nao_informado';
    const temQueixaIntermediaria =
      relato.febre === true ||
      relato.vomitos === true ||
      relato.sintomas.some((s) => /dor|febre|tosse|resfriado|enjoo|queimadura|queda|ferida|diarreia/i.test(s));

    if (rodadas === 0 && (semDuracao || temQueixaIntermediaria)) return true;
    if (rodadas === 1 && semIntensidade && semDuracao) return true;
  }

  return false;
}

export async function processarTurno(
  textoUsuario: string,
  estado: EstadoConversa,
): Promise<{ resultado: TurnoResultado; estado: EstadoConversa }> {
  // ============================================================
  // 1. EXTRAÇÃO CLÍNICA PRIMEIRO (antes de qualquer FAQ)
  // ============================================================
  const extraido = await interpretarRelato(textoUsuario);
  const sinalVermelho = temSinalVermelho(extraido);

  // ============================================================
  // 2. FAQ — só se NÃO houver sinal vermelho
  // ============================================================
  if (!sinalVermelho) {
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
  }

  // ============================================================
  // 3. Pedido de medicamento
  // ============================================================
  if (!sinalVermelho && ehPedidoMedicamento(textoUsuario)) {
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

  // ============================================================
  // 4. Pedido de diagnóstico
  // ============================================================
  if (!sinalVermelho && ehPedidoDiagnostico(textoUsuario)) {
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

  // ============================================================
  // 5. Saudação inicial — pergunta de triagem
  // ============================================================
  if (!sinalVermelho && estado.relatos.length === 0 && ehSaudacaoInicial(textoUsuario)) {
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

  // ============================================================
  // 6. Fora de escopo (sem conteúdo clínico na primeira interação)
  // ============================================================
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

  // ============================================================
  // 7. Consolida relato
  // ============================================================
  const textoAcumulado = estado.texto_original_acumulado
    ? `${estado.texto_original_acumulado} ${textoUsuario}`
    : textoUsuario;

  const relatos = [...estado.relatos, extraido];
  const atual = consolidar({ ...estado, relatos, texto_original_acumulado: textoAcumulado });

  // ============================================================
  // 8. Emergência imediata → sem perguntas
  // ============================================================
  const emergenciaImediata = temSinalVermelho(atual);

  // ============================================================
  // 9. Rodadas de refinamento (máx 2)
  // ============================================================
  if (!emergenciaImediata && precisaPerguntar(atual, estado.rodadasPerguntas)) {
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

  // ============================================================
  // 10. Decisão pelo motor de regras
  // ============================================================
  const decisao = aplicarMotor(atual, textoAcumulado);

  if (decisao.categoria_interna === 'informacao_insuficiente' && estado.rodadasPerguntas < 2) {
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