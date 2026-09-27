// src/ia/fallback.ts
// Caminho determinístico usado SÓ quando o LLM decisor falha (sem chave,
// timeout, JSON inválido). Garante que o bot continua triando sem LLM:
// extrator local + perguntas fixas + motor de regras.

import { extrairInformacoes, pareceDuvidaSobreTermo } from './extrator_de_informacoes.js';
import { aplicarMotor } from './motor_de_regras.js';
import { classificarNivel } from './sinais_criticos.js';
import { PERGUNTAS, escolherProximaPergunta, escolherTemaPergunta, interpretarRespostaCurta } from './perguntas.js';
import { mesclarRelatos } from './validador_de_saida.js';
import { comporResposta } from './compositor_mensagem.js';
import { mensagemPorId } from './mensagens.js';
import { normalizarTexto } from './normalizar.js';
import { decisaoDeRegras } from './validacao_final.js';
import { RELATO_VAZIO, type Decisao, type EstadoConversa, type RelatoEstruturado } from './tipos.js';

const MAX_RODADAS_FALLBACK = 2;

function temConteudoClinico(r: RelatoEstruturado): boolean {
  return (
    r.sintomas.length > 0 || r.sinais_alerta.length > 0 ||
    r.risco_mental !== 'nao_mencionado' || r.autodiagnostico_grave !== null ||
    r.sinais_neurologicos.length > 0 || r.sinais_trauma.length > 0 || r.sinais_obstetricos.length > 0
  );
}

function base(acao: Decisao['acao'], texto: string, motivo: string, extra: Partial<Decisao> = {}): Decisao {
  return {
    acao, texto, destino: 'NENHUM', pergunta_proxima: '', pergunta_rag: '',
    motivo_interno: `fallback: ${motivo}`, origem: 'fallback', ...extra,
  };
}

export function decidirSemLLM(
  texto: string,
  estado: EstadoConversa,
  textoCaso: string,
): { decisao: Decisao; relatos: RelatoEstruturado[] } {
  const coletando = estado.fase === 'coletando';
  const respostaCurta = coletando ? interpretarRespostaCurta(texto, estado.ultimaPergunta) : null;
  const extraido: RelatoEstruturado = respostaCurta
    ? { ...RELATO_VAZIO, ...respostaCurta }
    : extrairInformacoes(texto);
  const relatos = coletando ? [...estado.relatos, extraido] : [extraido];
  const atual: RelatoEstruturado = {
    ...relatos.reduce((acc, r) => mesclarRelatos(acc, r), { ...RELATO_VAZIO }),
    texto_original_acumulado: textoCaso,
  };

  const n = normalizarTexto(texto);
  if (!respostaCurta && !temConteudoClinico(extraido)) {
    if (/\?$/.test(texto.trim()) || pareceDuvidaSobreTermo(n)) {
      return { decisao: base('responder_rag', '', 'pergunta', { pergunta_rag: texto }), relatos: estado.relatos };
    }
    if (/^(oi+|ola|opa|e ?ai|bom dia|boa tarde|boa noite|tudo bem)\b/.test(n) && n.split(' ').length <= 4) {
      return { decisao: base('conversa', 'Olá! 😊 Me conta o que você está sentindo ou o que está acontecendo que eu te oriento.', 'saudacao'), relatos: estado.relatos };
    }
    if (/^(obrigad|valeu|brigad|vlw|ok|beleza|blz|tchau)/.test(n)) {
      return { decisao: base('conversa', mensagemPorId('encerramento_001').texto, 'agradecimento'), relatos: estado.relatos };
    }
    if (!coletando) {
      const p = escolherProximaPergunta('vago', RELATO_VAZIO, []);
      return { decisao: base('perguntar', p!.texto, 'sem conteúdo clínico', { pergunta_proxima: p!.texto }), relatos };
    }
  }

  const nivel = classificarNivel(atual);
  const idsFeitos = estado.perguntasJaFeitas ?? [];
  if (nivel !== 'critico' && estado.rodadasPerguntas < MAX_RODADAS_FALLBACK) {
    const tema = escolherTemaPergunta({
      sintomas: atual.sintomas, idade_grupo: atual.idade_grupo, gestante: atual.gestante,
      risco_mental: atual.risco_mental, falta_de_ar: atual.falta_de_ar, febre: atual.febre,
      sinais_trauma: atual.sinais_trauma,
    });
    // perguntasJaFeitas guarda o TEXTO das perguntas.
    const p = [...PERGUNTAS[tema], ...(tema !== 'vago' ? PERGUNTAS.vago : [])]
      .find((q) => !idsFeitos.includes(q.texto) && (!q.quando || q.quando(atual)));
    if (p) {
      return { decisao: base('perguntar', p.texto, `triagem tema ${tema}`, { pergunta_proxima: p.texto }), relatos };
    }
  }

  const d = aplicarMotor(atual, textoCaso);
  return {
    decisao: {
      ...decisaoDeRegras(d, 'fallback'),
      texto: comporResposta({ relato: atual, decisao: d, mensagemAprovada: mensagemPorId(d.resposta_id).texto }),
    },
    relatos,
  };
}
