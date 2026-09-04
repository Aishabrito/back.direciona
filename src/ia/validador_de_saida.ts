// ia/validador_de_saida.ts
import {
  IDADE_GRUPOS,
  RELATO_VAZIO,
  RISCOS_MENTAIS,
  VALORES_SIM_NAO,
  type FlagTriState,
  type RelatoEstruturado,
  type SimNao,
} from './tipos';

const DIAGNOSTICOS_BLOQUEADOS = [
  'infarto',
  'avc',
  'derrame',
  'cancer',
  'pneumonia',
  'covid',
  'dengue',
  'meningite',
  'apendicite',
  'diagnostico',
];

const MEDICAMENTOS_BLOQUEADOS = [
  'dipirona',
  'paracetamol',
  'ibuprofeno',
  'aspirina',
  'remedio',
  'comprimido',
  'antibiotico',
];

function asString(valor: unknown, padrao = 'nao_informado'): string {
  if (typeof valor === 'string' && valor.trim()) return valor.trim();
  return padrao;
}

function asSimNao(valor: unknown): SimNao {
  if (valor === true || valor === 'sim') return 'sim';
  if (valor === false || valor === 'nao' || valor === 'não') return 'nao';
  if (VALORES_SIM_NAO.includes(valor as SimNao)) return valor as SimNao;
  return 'nao_informado';
}

function asFlag(valor: unknown): FlagTriState {
  if (valor === true || valor === 'true' || valor === 'sim') return true;
  if (valor === false || valor === 'false' || valor === 'nao' || valor === 'não') return false;
  return 'nao_informado';
}

function asLista(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !contemTermoBloqueado(item));
}

function contemTermoBloqueado(texto: string): boolean {
  const n = texto.toLowerCase();
  return [...DIAGNOSTICOS_BLOQUEADOS, ...MEDICAMENTOS_BLOQUEADOS].some((termo) => n.includes(termo));
}

export function relatoPadrao(parcial: Partial<RelatoEstruturado> = {}): RelatoEstruturado {
  return { ...RELATO_VAZIO, ...parcial };
}

export function validarRelato(entrada: unknown): { ok: true; relato: RelatoEstruturado } | { ok: false; relato: RelatoEstruturado } {
  if (!entrada || typeof entrada !== 'object') {
    return { ok: false, relato: RELATO_VAZIO };
  }

  const bruto = entrada as Record<string, unknown>;
  const idade = IDADE_GRUPOS.includes(bruto.idade_grupo as (typeof IDADE_GRUPOS)[number])
    ? (bruto.idade_grupo as RelatoEstruturado['idade_grupo'])
    : 'nao_informado';
  const risco = RISCOS_MENTAIS.includes(bruto.risco_mental as (typeof RISCOS_MENTAIS)[number])
    ? (bruto.risco_mental as RelatoEstruturado['risco_mental'])
    : 'nao_mencionado';

  const relato: RelatoEstruturado = {
    relato_sobre_terceiro: Boolean(bruto.relato_sobre_terceiro),
    pessoa: asString(bruto.pessoa),
    idade_grupo: idade,
    sintomas: asLista(bruto.sintomas),
    sinais_alerta: asLista(bruto.sinais_alerta),
    inicio: asString(bruto.inicio),
    duracao: asString(bruto.duracao),
    piora: asSimNao(bruto.piora),
    intensidade: asString(bruto.intensidade),
    falta_de_ar: asFlag(bruto.falta_de_ar),
    dor_no_peito: asFlag(bruto.dor_no_peito),
    desmaio: asFlag(bruto.desmaio),
    confusao: asFlag(bruto.confusao),
    sangramento: asFlag(bruto.sangramento),
    febre: asFlag(bruto.febre),
    vomitos: asFlag(bruto.vomitos),
    trauma: asFlag(bruto.trauma),
    exposicao_intoxicacao: asFlag(bruto.exposicao_intoxicacao),
    gestante: asSimNao(bruto.gestante),
    pos_parto: asSimNao(bruto.pos_parto),
    risco_mental: risco,
    informacao_insuficiente: Boolean(bruto.informacao_insuficiente),
    informacoes_contraditorias: asLista(bruto.informacoes_contraditorias),
    sinais_obstetricos: asLista(bruto.sinais_obstetricos),
    sinais_trauma: asLista(bruto.sinais_trauma),
    texto_original_acumulado: asString(bruto.texto_original_acumulado, ''),
  };

  const formatoOk =
    Array.isArray(bruto.sintomas) &&
    IDADE_GRUPOS.includes(bruto.idade_grupo as (typeof IDADE_GRUPOS)[number]) &&
    VALORES_SIM_NAO.includes(asSimNao(bruto.gestante));

  return { ok: formatoOk, relato };
}

// ============================================================
// ========== LÓGICA DE MESCLAGEM COM NEGAÇÃO ==========
// ============================================================

/**
 * Prefere o novo valor, exceto quando a negação é fornecida.
 * A negação ('nao') SEMPRE prevalece sobre qualquer outro valor.
 */
function preferirComNegacao<T extends string>(
  atual: T,
  novo: T,
  vazio: T,
  negacao: T
): T {
  // Se o novo for a negação, prevalece imediatamente
  if (novo === negacao) return novo;
  // Se o novo não for vazio, use-o
  if (novo !== vazio) return novo;
  // Caso contrário, mantenha o atual
  return atual;
}

/**
 * Para flags booleanas: `false` (negação) prevalece sobre `true` e sobre `'nao_informado'`
 */
function preferirFlagComNegacao(atual: FlagTriState, novo: FlagTriState): FlagTriState {
  // Se o novo for false (negação), prevalece
  if (novo === false) return false;
  // Se o novo for true, use-o
  if (novo === true) return true;
  // Se o novo for 'nao_informado', mantenha o atual
  return atual;
}

export function mesclarRelatos(base: RelatoEstruturado, extra: RelatoEstruturado): RelatoEstruturado {
  const unirArrays = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];

  return {
    // ----- CAMPOS DE IDENTIFICAÇÃO -----
    relato_sobre_terceiro: extra.relato_sobre_terceiro || base.relato_sobre_terceiro,
    pessoa: extra.pessoa !== 'nao_informado' ? extra.pessoa : base.pessoa,
    idade_grupo: extra.idade_grupo !== 'nao_informado' ? extra.idade_grupo : base.idade_grupo,

    // ----- LISTAS (união sem duplicatas) -----
    sintomas: unirArrays(base.sintomas, extra.sintomas),
    sinais_alerta: unirArrays(base.sinais_alerta, extra.sinais_alerta),
    sinais_obstetricos: unirArrays(base.sinais_obstetricos, extra.sinais_obstetricos),
    sinais_trauma: unirArrays(base.sinais_trauma, extra.sinais_trauma),
    informacoes_contraditorias: unirArrays(base.informacoes_contraditorias, extra.informacoes_contraditorias),

    // ----- TEXTO ORIGINAL -----
    texto_original_acumulado: extra.texto_original_acumulado || base.texto_original_acumulado || '',

    // ----- DURAÇÃO / INÍCIO / PIORA / INTENSIDADE -----
    inicio: extra.inicio !== 'nao_informado' ? extra.inicio : base.inicio,
    duracao: extra.duracao !== 'nao_informado' ? extra.duracao : base.duracao,
    piora: extra.piora !== 'nao_informado' ? extra.piora : base.piora,
    intensidade: extra.intensidade !== 'nao_informado' ? extra.intensidade : base.intensidade,

    // ----- CAMPOS "SIM / NAO" COM NEGAÇÃO PRIORITÁRIA -----
    // Se o usuário disser "não estou grávida", isso prevalece
    gestante: preferirComNegacao(base.gestante, extra.gestante, 'nao_informado', 'nao'),
    pos_parto: preferirComNegacao(base.pos_parto, extra.pos_parto, 'nao_informado', 'nao'),

    // ----- FLAGS BOOLEANAS: "false" (negação) PREVALECE -----
    falta_de_ar: preferirFlagComNegacao(base.falta_de_ar, extra.falta_de_ar),
    dor_no_peito: preferirFlagComNegacao(base.dor_no_peito, extra.dor_no_peito),
    desmaio: preferirFlagComNegacao(base.desmaio, extra.desmaio),
    confusao: preferirFlagComNegacao(base.confusao, extra.confusao),
    sangramento: preferirFlagComNegacao(base.sangramento, extra.sangramento),
    febre: preferirFlagComNegacao(base.febre, extra.febre),
    vomitos: preferirFlagComNegacao(base.vomitos, extra.vomitos),
    trauma: preferirFlagComNegacao(base.trauma, extra.trauma),
    exposicao_intoxicacao: preferirFlagComNegacao(base.exposicao_intoxicacao, extra.exposicao_intoxicacao),

    // ----- RISCO MENTAL: "nao_mencionado" é o menos prioritário -----
    risco_mental: extra.risco_mental !== 'nao_mencionado' ? extra.risco_mental : base.risco_mental,

    // ----- INFORMAÇÃO INSUFICIENTE: só é verdade se ambos forem -----
    informacao_insuficiente: extra.informacao_insuficiente && base.informacao_insuficiente,
  };
}