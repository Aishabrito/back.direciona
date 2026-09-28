// src/ia/validacao_final.ts
// Única camada determinística DEPOIS do decisor. Não tenta adivinhar intenção;
// só garante que a decisão é segura e bem formada:
//   1. Piso de segurança: se o relato do caso tem critério crítico, nunca sai abaixo de emergência.
//   2. Emergência vinda do LLM usa destino e texto aprovados (o LLM não escreve texto de emergência).
//   3. Texto que diagnostica ou indica remédio é substituído — sem rebaixar o destino.
//   4. "perguntar" sem pergunta (ou além do limite) vira pergunta fixa ou orientação do motor.

import { extrairInformacoes } from './extrator_de_informacoes.js';
import { encontrarCriterioCritico } from './sinais_criticos.js';
import { PERGUNTAS, escolherTemaPergunta } from './perguntas.js';
import { aplicarMotor } from './motor_de_regras.js';
import { mensagemPorId, sanitizarTextoGerado } from './mensagens.js';
import { normalizarTexto } from './normalizar.js';
import { MAX_PERGUNTAS_POR_CASO } from './decisor.js';
import { ehAcidenteDeTransito, acidentePassadoSemGravidade, acidenteAntigoSemGravidade, TEXTO_ACIDENTE_RECENTE } from './acidente.js';
import type { Decisao, DecisaoRegras, DestinoDecisor, EstadoConversa } from './tipos.js';

// ────────────────────────────────────────────────────
// TEXTOS APROVADOS
// ────────────────────────────────────────────────────
const TEXTO_CVV =
  '💛 Estou aqui com você. Se você está pensando em se machucar, ligue agora para o *CVV 188* (24h, gratuito, sigiloso). Em perigo imediato, ligue *192 (SAMU)* ou vá a uma UPA.';

const TEXTO_UPA_AGORA =
  '⚠️ Procure *agora* uma UPA 24h ou Pronto-Socorro. Se piorar no caminho (falta de ar, desmaio, confusão), ligue *192 (SAMU)*.';

export function templateEmergencia(destino: DestinoDecisor): { texto: string; resposta_id: string } {
  switch (destino) {
    case 'CVV': return { texto: TEXTO_CVV, resposta_id: 'mental_emergencia_001' };
    case 'MATERNIDADE': return { texto: mensagemPorId('obstetricia_001').texto, resposta_id: 'obstetricia_001' };
    case 'UPA': return { texto: TEXTO_UPA_AGORA, resposta_id: 'upa_001' };
    default: return { texto: mensagemPorId('emergencia_001').texto, resposta_id: 'emergencia_001' };
  }
}

// Linha fixa anexada às orientações escritas pelo LLM — garante que "onde ir"
// e "quando ligar 192" sempre aparecem, mesmo se o texto gerado esquecer.
const LINHA_DESTINO: Partial<Record<DestinoDecisor, string>> = {
  UPA: '👉 *Onde ir:* UPA 24h, ainda hoje. Se surgir falta de ar, desmaio, confusão ou piora rápida, ligue *192*.',
  UBS: '👉 *Onde ir:* UBS / Clínica da Família. Se piorar ou surgir falta de ar, dor no peito, desmaio ou confusão, procure uma UPA ou ligue *192*.',
  CAPS: '👉 *Onde ir:* CAPS ou UBS da sua região. Se surgir vontade de se machucar, ligue *188 (CVV)* ou *192*.',
  MATERNIDADE: '👉 *Onde ir:* maternidade de referência / pronto-socorro obstétrico. Em sangramento, perda de líquido ou dor forte, ligue *192*.',
};

const RESPOSTA_ID_ORIENTAR: Partial<Record<DestinoDecisor, string>> = {
  UPA: 'upa_001', UBS: 'ubs_001', CAPS: 'mental_caps_001', MATERNIDADE: 'obstetricia_001',
};

export const TEXTO_SEGURO_RAG =
  'Não consigo te dar essa informação com segurança por aqui. Se você estiver com algum sintoma, me conta o que sente que eu te oriento onde buscar atendimento. ' +
  'Em caso de falta de ar, dor no peito, desmaio ou confusão, ligue *192*.';

// ────────────────────────────────────────────────────
// DETECÇÃO DE DIAGNÓSTICO / PRESCRIÇÃO NO TEXTO GERADO
// ────────────────────────────────────────────────────
const DOENCAS =
  'gripe|influenza|dengue|zika|chikungunya|covid|coronavirus|pneumonia|infarto|avc|derrame|meningite|apendicite|cancer|gastrite|sinusite|amigdalite|bronquite|asma|hepatite|tuberculose|hanseniase|infeccao urinaria|enxaqueca|virose|trombose|embolia';

const PADROES_DIAGNOSTICO: RegExp[] = [
  /\b(voce|o senhor|a senhora|ele|ela|seu filho|sua filha)\b[^.!?]{0,40}\b(pode|deve|parece|provavelmente|possivelmente)\b[^.!?]{0,30}\b(ter|estar com|ser)\b/,
  /\b(seus?|esses?|teus?)\s+sintomas?\b[^.!?]{0,40}\b(sao de|indicam|sugerem|apontam|revelam|batem com|sao compativeis|sao tipicos)\b/,
  new RegExp(`\\b(isso|isto|esse quadro|esse caso)\\b[^.!?]{0,30}\\b(e|pode ser|deve ser|parece)\\b[^.!?]{0,20}\\b(${DOENCAS})\\b`),
  // Só quando atribuído à pessoa ("você tem suspeita de", "parece um quadro de");
  // texto educativo como "se houver suspeita de dengue, procure a UBS" passa.
  new RegExp(`\\b(tem|esta com|parece|e|eh)\\s+(um\\s+|uma\\s+)?(quadro|caso|suspeita)\\s+de\\s+(${DOENCAS})\\b`),
  new RegExp(`\\b(compativel|compativeis)\\s+com\\s+(${DOENCAS})\\b`),
  /\b(diagnostico|prognostico)\b[^.!?]{0,30}\b(e|provavel|sugere|indica)\b/,
  new RegExp(`\\b(provavelmente|possivelmente|aparentemente)\\b[^.!?]{0,30}\\b(${DOENCAS})\\b`),
];

const REMEDIOS =
  'dipirona|paracetamol|ibuprofeno|aspirina|aas|diclofenaco|nimesulida|amoxicilina|azitromicina|omeprazol|buscopan|loratadina|dramin|plasil|soro|antibiotico|anti inflamatorio|antiinflamatorio|cha de|xarope';

const PADROES_PRESCRICAO: RegExp[] = [
  new RegExp(`(?<!nao )(?<!nunca )\\b(tome|tomar|use|usar|pode tomar|recomendo|indico|passe|aplique)\\b[^.!?]{0,30}\\b(${REMEDIOS})\\b`),
  /\b\d+\s*(mg|ml|gotas|comprimidos?)\b/,
  /\bde\s+\d+\s+em\s+\d+\s+horas\b/,
];

export function contemDiagnostico(texto: string): boolean {
  const n = normalizarTexto(texto);
  return PADROES_DIAGNOSTICO.some((p) => p.test(n));
}

export function contemPrescricao(texto: string): boolean {
  const n = normalizarTexto(texto);
  return PADROES_PRESCRICAO.some((p) => p.test(n));
}

function textoInseguro(texto: string): boolean {
  return contemDiagnostico(texto) || contemPrescricao(texto) || sanitizarTextoGerado(texto) !== texto;
}

// ────────────────────────────────────────────────────
// PISO DETERMINÍSTICO
// ────────────────────────────────────────────────────
// Autodiagnóstico ("meu pai teve AVC ano passado") gera falso positivo demais para
// forçar SAMU sozinho; o LLM e a guarda cuidam desse caso.
const CRITERIOS_IGNORADOS_NO_PISO = new Set(['autodiagnostico_grave']);

export function pisoCritico(textoCaso: string): { motivo: string; destino: DestinoDecisor } | null {
  if (!textoCaso.trim()) return null;
  const relato = extrairInformacoes(textoCaso);
  // Mecanismo de trauma grave (acidente de moto/carro, atropelamento, queda de altura, arma).
  if (relato.sinais_trauma.includes('ferimento_perfurante')) {
    return { motivo: 'ferimento por arma', destino: 'SAMU_192' };
  }
  const mecanismo = relato.sinais_trauma.some((s) => s === 'trauma_automobilistico' || s === 'queda_altura');
  if (mecanismo && !acidentePassadoSemGravidade(textoCaso)) {
    return { motivo: 'mecanismo de trauma grave', destino: 'SAMU_192' };
  }
  const criterio = encontrarCriterioCritico(relato);
  if (!criterio || CRITERIOS_IGNORADOS_NO_PISO.has(criterio.id)) return null;
  const destino: DestinoDecisor =
    criterio.id === 'mental_iminente' ? 'CVV'
    : criterio.id === 'obstetricia_critica' ? 'MATERNIDADE'
    : 'SAMU_192';
  return { motivo: criterio.motivo, destino };
}

// Piso de urgência: situações em que UBS é pouco — precisa de avaliação HOJE.
const TEXTO_CEFALEIA_FEBRE =
  '🤕 Dor de cabeça com febre e dor na nuca precisa ser avaliada *ainda hoje* numa *UPA 24h*.\n\n' +
  '*Ligue 192 na hora* se o pescoço ficar duro (não consegue encostar o queixo no peito), aparecerem manchas roxas na pele, ' +
  'sonolência, confusão, vômitos repetidos ou convulsão.';

const TEXTO_QUEIMADURA_UPA =
  '🔥 Essa queimadura precisa ser avaliada *ainda hoje* numa *UPA 24h*.\n\n' +
  '*Agora:* resfrie com água corrente em temperatura ambiente por até 20 minutos (sem gelo), tire anéis e relógios, ' +
  'e cubra com pano limpo. *Não* passe manteiga, pasta de dente, pó de café nem pomada, e *não* estoure bolhas.\n\n' +
  '*Ligue 192* se a queimadura for grande, a pele ficar branca ou preta, houver falta de ar, rouquidão ou se tiver inalado fumaça.';

const TEXTO_CHOQUE_UPA =
  '⚡ Depois de um choque elétrico, procure uma *UPA 24h ainda hoje*, mesmo que pareça bem: ' +
  'o choque pode afetar o coração e causar lesões por dentro.\n\n' +
  '*Ligue 192* se houver desmaio, falta de ar, dor no peito, batedeira, confusão ou queimadura na pele.';

const TEXTO_DENTE_TRAUMA =
  '🦷 Dente arrancado ou quebrado por pancada precisa de atendimento *o quanto antes* (o ideal é em até 1 hora): ' +
  'procure uma *UPA* ou um pronto-socorro odontológico.\n\n' +
  '*Se o dente saiu inteiro:* segure pela parte branca, *nunca pela raiz*. Se estiver sujo, passe só em água corrente, sem esfregar. ' +
  'Leve dentro de um copo de *leite* (ou na saliva, dentro da boca). Não embrulhe em papel e não deixe secar. ' +
  '*Dente de leite não se recoloca.*\n\n' +
  '*Ligue 192* se houve pancada forte na cabeça, desmaio, vômito ou sangramento que não para.';

const TEXTO_NARIZ_UPA =
  '🩸 *Agora:* sente, incline a cabeça *para frente* (não para trás) e aperte a parte mole do nariz por 10 a 15 minutos sem soltar. Cuspa o sangue que for para a boca.\n\n' +
  'Se não parar depois de 20 minutos apertando, se a pessoa usa remédio para afinar o sangue, ou se o sangramento é muito forte, procure *agora* uma *UPA 24h*.\n\n' +
  '*Ligue 192* se houver tontura forte, desmaio ou palidez.';

const TEXTO_AFOGAMENTO_UPA =
  '🌊 Mesmo que a pessoa pareça bem, quem quase se afogou precisa ser avaliado *hoje* numa *UPA 24h*: a água no pulmão pode causar problemas horas depois.\n\n' +
  '*Ligue 192* se aparecer tosse que não para, falta de ar, respiração rápida, lábios roxos, sonolência, confusão ou vômitos.';

const TEXTO_DOR_ATRASO =
  '🤰 Dor na barriga com atraso menstrual ou gravidez no início precisa ser avaliada *hoje*: procure a *maternidade* / pronto-socorro obstétrico (ou uma UPA, se for mais perto).\n\n' +
  '*Ligue 192* se a dor for muito forte, se tiver sangramento com tontura ou desmaio, ou dor no ombro.';

function denteTraumatizado(n: string): boolean {
  const dente = /\b(dente|dentes)\b[^.!?]{0,30}\b(saiu|caiu|arrancou|arrancad[oa]s?|voou|quebrou|quebrad[oa]s?|lascou|entortou|afundou)\b|\b(quebrei|quebrou|arranquei|arrancou|perdi|perdeu|lasquei|lascou) (o |um |uma |os |dois )?(dente|dentes|pedaco do dente)\b/.test(n);
  const trauma = /\b(bati|bateu|queda|tombo|pancada|soco|batida|acidente|bolada|briga|cai (de|da|do|no|na)|caiu (de|da|do|no|na)|tropecei|tropecou|levou uma)\b/.test(n);
  return dente && trauma && !/\bdente de leite\b[^.!?]{0,20}\b(mole|caiu sozinho)\b/.test(n);
}

function sangramentoNasalQueExigeUpa(n: string): boolean {
  return /\b(nariz|nasal)\b/.test(n) && /\b(sangr\w*|sangue)\b/.test(n)
    && /\b(nao para|nao parou|nao estanca|mais de (20|vinte|meia)|muito|muita|forte|anticoagul\w*|afinar o sangue|marevan|varfarina|xarelto|rivaroxabana|clopidogrel)\b/.test(n);
}

function dorComAtrasoMenstrual(n: string): boolean {
  const possivelGravidez = /\b(atraso (menstrual|da menstruacao)|menstruacao (esta |ta )?(atrasada|nao veio)|(teste|beta)( de gravidez)? (deu )?positivo|gravidez no (inicio|comeco)|posso estar gravida|acho que (estou|to|tou) gravida|gravida de (\d|um|uma|dois|duas|poucas) semanas?)\b/.test(n);
  const dor = /\b(dor (forte |muito forte |intensa )?(na|no|de|do) (barriga|pe da barriga|ventre|baixo ventre|lado|abdomen)|colica (muito )?forte|dor abdominal)\b/.test(n);
  return possivelGravidez && dor;
}

// Queimadura (não "queimando"/"queimação") com bolha, em área nobre, ou em bebê/criança/idoso.
function queimaduraQueExigeUpa(n: string): boolean {
  const queimadura = /\b(queimadura|queimei|queimou|queimad[oa]|me queimei|se queimou|escaldad[oa]|escaldou)\b/.test(n);
  if (!queimadura) return false;
  const bolha = /\bbolha/.test(n);
  const local = /\b(rosto|face|olho|olhos|orelha|pescoco|mao|maos|pe|pes|genita\w*|virilha|penis|vagina|saco|joelho|cotovelo|axila|articula\w*)\b/.test(n);
  const grupo = /\b(bebe|nenem|recem nascido|crianca|meu filho|minha filha|idos[oa]|vo|avo|gravida|gestante|diabetic[oa]|diabetes)\b/.test(n);
  const grande = /\b(maior que (a |uma )?(palma|mao)|grande|extensa|braco (todo|inteiro)|perna (toda|inteira)|barriga toda|costas todas?)\b/.test(n);
  const aparencia = /\b(branca|esbranquicad\w*|sem sensibilidade|nao doi nada)\b/.test(n);
  return bolha || local || grupo || grande || aparencia;
}

export function pisoUrgencia(textoCaso: string): { motivo: string; texto: string; destino?: DestinoDecisor } | null {
  const n = normalizarTexto(textoCaso);
  const cefaleia = /\b(dor de cabeca|cabeca doendo|cefaleia|enxaqueca)\b/.test(n);
  const nuca = /\b(nuca|pescoco)\b/.test(n);
  const febre = /\b(febre|febril|temperatura alta|38|39|40 graus)\b/.test(n) && !/\b(sem|nao tenho|nao tem) febre\b/.test(n);
  if (cefaleia && nuca && febre) return { motivo: 'dor de cabeça + nuca + febre', texto: TEXTO_CEFALEIA_FEBRE };
  if (queimaduraQueExigeUpa(n)) return { motivo: 'queimadura com critério de UPA', texto: TEXTO_QUEIMADURA_UPA };
  if (/\b(levou|tomou|levei|tomei|levou um|deu um) (um )?choque\b|\bchoque eletrico\b/.test(n) && !/\bnao (levou|tomou|levei|tomei)/.test(n)) {
    return { motivo: 'choque elétrico', texto: TEXTO_CHOQUE_UPA };
  }
  if (denteTraumatizado(n)) return { motivo: 'trauma dentário', texto: TEXTO_DENTE_TRAUMA };
  if (sangramentoNasalQueExigeUpa(n)) return { motivo: 'sangramento nasal que exige UPA', texto: TEXTO_NARIZ_UPA };
  if (/\b(afog\w*|quase se afogou|engoliu muita agua|ficou (embaixo|debaixo) d.?agua)\b/.test(n)) {
    return { motivo: 'afogamento recente', texto: TEXTO_AFOGAMENTO_UPA };
  }
  if (dorComAtrasoMenstrual(n)) return { motivo: 'dor + possível gravidez inicial', texto: TEXTO_DOR_ATRASO, destino: 'MATERNIDADE' };
  if (ehAcidenteDeTransito(textoCaso) && !acidenteAntigoSemGravidade(textoCaso)) {
    return { motivo: 'acidente de trânsito recente', texto: TEXTO_ACIDENTE_RECENTE };
  }
  return null;
}

// ────────────────────────────────────────────────────
// MOTOR (usado quando o decisor não consegue fechar a decisão)
// ────────────────────────────────────────────────────
const DESTINO_DO_MOTOR: Record<DecisaoRegras['destino'], DestinoDecisor> = {
  SAMU_192: 'SAMU_192',
  PRONTO_SOCORRO: 'SAMU_192',
  SAMU_192_PRONTO_SOCORRO: 'SAMU_192',
  UPA_24H: 'UPA',
  UBS_CLINICA_DA_FAMILIA: 'UBS',
  MATERNIDADE_PRONTO_SOCORRO_OBSTETRICO: 'MATERNIDADE',
  CAPS_OU_SERVICO_DE_SAUDE_MENTAL: 'CAPS',
  CVV_188: 'CVV',
  FALLBACK: 'UBS',
};

export function decisaoDoMotor(textoCaso: string, motivo: string): Decisao {
  const relato = { ...extrairInformacoes(textoCaso), texto_original_acumulado: textoCaso };
  return decisaoDeRegras(aplicarMotor(relato, textoCaso), motivo);
}

export function decisaoDeRegras(d: DecisaoRegras, motivo: string): Decisao {
  return {
    acao: d.nivel === 'SAMU_AGORA' ? 'emergencia' : 'orientar',
    texto: mensagemPorId(d.resposta_id).texto,
    destino: DESTINO_DO_MOTOR[d.destino],
    pergunta_proxima: '',
    pergunta_rag: '',
    motivo_interno: `${motivo}; motor: ${d.regra_acionada}`,
    origem: 'fallback',
    resposta_id: d.resposta_id,
  };
}

// ────────────────────────────────────────────────────
// VALIDAÇÃO
// ────────────────────────────────────────────────────
export type ResultadoValidacao = { decisao: Decisao; alterou: boolean; motivos: string[] };

export function validarDecisao(
  entrada: Decisao,
  ctx: { textoCaso: string; estado: EstadoConversa },
): ResultadoValidacao {
  let d: Decisao = { ...entrada };
  const motivos: string[] = [];
  const doLLM = d.origem === 'llm';
  const perguntasFeitas = ctx.estado.fase === 'coletando' ? ctx.estado.perguntasJaFeitas ?? [] : [];

  // 1. Piso de segurança — nunca abaixo de emergência se o relato tem critério crítico.
  if (d.acao !== 'emergencia') {
    const piso = pisoCritico(ctx.textoCaso);
    if (piso) {
      const t = templateEmergencia(piso.destino);
      d = { ...d, acao: 'emergencia', destino: piso.destino, texto: t.texto, resposta_id: t.resposta_id };
      motivos.push(`piso_critico: ${piso.motivo}`);
    }
  }

  // 1b. Piso de urgência — casos que nunca podem sair abaixo de UPA.
  if (d.acao === 'orientar' && d.destino !== 'UPA' && d.destino !== 'MATERNIDADE') {
    const urg = pisoUrgencia(ctx.textoCaso);
    if (urg) {
      motivos.push(`piso_urgencia: ${urg.motivo}`);
      return {
        decisao: {
          ...d, destino: urg.destino ?? 'UPA', texto: urg.texto,
          resposta_id: urg.destino === 'MATERNIDADE' ? 'obstetricia_001' : 'upa_001',
        },
        alterou: true, motivos,
      };
    }
  }

  // 2. Emergência: destino tem que ser de emergência; texto do LLM vira texto aprovado.
  if (d.acao === 'emergencia') {
    if (!['SAMU_192', 'CVV', 'UPA', 'MATERNIDADE'].includes(d.destino)) {
      d.destino = 'SAMU_192';
      motivos.push('emergencia_sem_destino_valido');
    }
    if (doLLM && !motivos.some((m) => m.startsWith('piso_critico'))) {
      const t = templateEmergencia(d.destino);
      d.texto = t.texto;
      d.resposta_id = t.resposta_id;
    }
    return { decisao: d, alterou: motivos.length > 0, motivos };
  }

  // 3. "orientar" com SAMU/CVV é emergência disfarçada → sobe para emergência.
  if (d.acao === 'orientar' && (d.destino === 'SAMU_192' || d.destino === 'CVV')) {
    const t = templateEmergencia(d.destino);
    motivos.push('orientar_com_destino_de_emergencia');
    return { decisao: { ...d, acao: 'emergencia', texto: t.texto, resposta_id: t.resposta_id }, alterou: true, motivos };
  }

  // 4. "perguntar": precisa de pergunta, não pode repetir, e respeita o limite.
  if (d.acao === 'perguntar') {
    const jaFeita = (p: string) => perguntasFeitas.some((f) => normalizarTexto(f) === normalizarTexto(p));
    if (perguntasFeitas.length >= MAX_PERGUNTAS_POR_CASO) {
      motivos.push('limite_de_perguntas');
      return { decisao: decisaoDoMotor(ctx.textoCaso, 'limite de perguntas'), alterou: true, motivos };
    }
    if (!d.pergunta_proxima || !d.pergunta_proxima.includes('?') || jaFeita(d.pergunta_proxima) || textoInseguro(d.pergunta_proxima)) {
      const relato = extrairInformacoes(ctx.textoCaso);
      const tema = escolherTemaPergunta({
        sintomas: relato.sintomas, idade_grupo: relato.idade_grupo, gestante: relato.gestante,
        risco_mental: relato.risco_mental, falta_de_ar: relato.falta_de_ar, febre: relato.febre,
        sinais_trauma: relato.sinais_trauma,
      });
      const fixa = [...PERGUNTAS[tema], ...(tema !== 'vago' ? PERGUNTAS.vago : [])]
        .find((p) => !jaFeita(p.texto));
      if (!fixa) {
        motivos.push('perguntar_sem_pergunta_valida');
        return { decisao: decisaoDoMotor(ctx.textoCaso, 'sem pergunta válida'), alterou: true, motivos };
      }
      motivos.push('pergunta_substituida');
      d = { ...d, pergunta_proxima: fixa.texto, texto: fixa.texto };
    }
    if (textoInseguro(d.texto)) {
      motivos.push('texto_pergunta_inseguro');
      d.texto = d.pergunta_proxima;
    }
    if (!d.texto.includes(d.pergunta_proxima)) {
      d.texto = d.texto ? `${d.texto}\n\n${d.pergunta_proxima}` : d.pergunta_proxima;
    }
    return { decisao: d, alterou: motivos.length > 0, motivos };
  }

  // 5. "orientar": destino obrigatório; texto seguro; linha "onde ir" sempre presente.
  if (d.acao === 'orientar') {
    if (d.destino === 'NENHUM') {
      motivos.push('orientar_sem_destino');
      return { decisao: decisaoDoMotor(ctx.textoCaso, 'orientar sem destino'), alterou: true, motivos };
    }
    d.resposta_id = d.resposta_id ?? RESPOSTA_ID_ORIENTAR[d.destino];
    if (doLLM) {
      if (!d.texto || textoInseguro(d.texto)) {
        if (d.texto) motivos.push('texto_orientacao_inseguro');
        d.texto = mensagemPorId(d.resposta_id ?? 'fallback_001').texto;
      } else if (LINHA_DESTINO[d.destino]) {
        d.texto = `${d.texto}\n\n${LINHA_DESTINO[d.destino]}`;
      }
    }
    return { decisao: d, alterou: motivos.length > 0, motivos };
  }

  // 6. responder_rag / conversa / fora_escopo: só checa o texto.
  if (textoInseguro(d.texto)) {
    motivos.push('texto_inseguro');
    d.texto = d.acao === 'responder_rag' ? TEXTO_SEGURO_RAG : mensagemPorId('fora_escopo_001').texto;
  }
  if (!d.texto) {
    d.texto = d.acao === 'conversa'
      ? 'Olá! 😊 Me conta o que você está sentindo ou o que está acontecendo que eu te oriento.'
      : mensagemPorId('fora_escopo_001').texto;
  }
  return { decisao: d, alterou: motivos.length > 0, motivos };
}
