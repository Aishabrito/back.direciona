import {
  IDADE_GRUPOS, RELATO_VAZIO, RISCOS_MENTAIS, VALORES_SIM_NAO,
  type FlagTriState, type RelatoEstruturado, type SimNao, type RiscoMental,
} from './tipos';

const MEDICAMENTOS_BLOQUEADOS = [
  'dipirona', 'paracetamol', 'ibuprofeno', 'aspirina',
  'remedio', 'comprimido', 'antibiotico',
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
    .filter((item) => {
      const n = item.toLowerCase();
      return !MEDICAMENTOS_BLOQUEADOS.some((t) => n.includes(t));
    });
}

export function relatoPadrao(parcial: Partial<RelatoEstruturado> = {}): RelatoEstruturado {
  return { ...RELATO_VAZIO, ...parcial };
}

export function validarRelato(entrada: unknown):
  | { ok: true; relato: RelatoEstruturado }
  | { ok: false; relato: RelatoEstruturado } {
  if (!entrada || typeof entrada !== 'object') {
    return { ok: false, relato: { ...RELATO_VAZIO } };
  }
  const bruto = entrada as Record<string, unknown>;

  const idade = IDADE_GRUPOS.includes(bruto.idade_grupo as any)
    ? (bruto.idade_grupo as RelatoEstruturado['idade_grupo'])
    : 'nao_informado';

  const risco: RiscoMental = RISCOS_MENTAIS.includes(bruto.risco_mental as any)
    ? (bruto.risco_mental as RiscoMental)
    : 'nao_mencionado';

  const relato: RelatoEstruturado = {
    relato_sobre_terceiro: Boolean(bruto.relato_sobre_terceiro),
    pessoa: asString(bruto.pessoa),
    idade_grupo: idade,
    idade_numerica: typeof bruto.idade_numerica === 'number' ? bruto.idade_numerica : null,
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
    sinais_neurologicos: asLista(bruto.sinais_neurologicos),
    fala_frases: asFlag(bruto.fala_frases),
    labios_roxos: asFlag(bruto.labios_roxos),
    consegue_beber: asFlag(bruto.consegue_beber),
    alergia_grave: asFlag(bruto.alergia_grave),
    autodiagnostico_grave: typeof bruto.autodiagnostico_grave === 'string'
      ? bruto.autodiagnostico_grave
      : null,
    texto_original_acumulado: asString(bruto.texto_original_acumulado, ''),
  };

  const formatoOk = Array.isArray(bruto.sintomas);
  return { ok: formatoOk, relato };
}

// ============================================================
// MESCLAGEM COM NEGAÇÃO
// ============================================================
function preferirComNegacao<T extends string>(
  atual: T, novo: T, vazio: T, negacao: T,
): T {
  if (novo === negacao) return novo;
  if (novo !== vazio) return novo;
  return atual;
}

function preferirFlagComNegacao(atual: FlagTriState, novo: FlagTriState): FlagTriState {
  if (novo === false) return false;
  if (novo === true) return true;
  return atual;
}

// [FIX] risco_mental nunca é rebaixado
const ORDEM_RISCO: Record<RiscoMental, number> = {
  nao_mencionado: 0, sem_risco_imediato: 1, iminente: 2,
};

export function mesclarRelatos(base: RelatoEstruturado, extra: RelatoEstruturado): RelatoEstruturado {
  const unir = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];

  return {
    relato_sobre_terceiro: extra.relato_sobre_terceiro || base.relato_sobre_terceiro,
    pessoa: extra.pessoa !== 'nao_informado' ? extra.pessoa : base.pessoa,
    idade_grupo: extra.idade_grupo !== 'nao_informado' ? extra.idade_grupo : base.idade_grupo,
    idade_numerica: extra.idade_numerica ?? base.idade_numerica ?? null,
    sintomas: unir(base.sintomas, extra.sintomas),
    sinais_alerta: unir(base.sinais_alerta, extra.sinais_alerta),
    sinais_obstetricos: unir(base.sinais_obstetricos, extra.sinais_obstetricos),
    sinais_trauma: unir(base.sinais_trauma, extra.sinais_trauma),
    sinais_neurologicos: unir(base.sinais_neurologicos, extra.sinais_neurologicos),
    informacoes_contraditorias: unir(base.informacoes_contraditorias, extra.informacoes_contraditorias),
    texto_original_acumulado: extra.texto_original_acumulado || base.texto_original_acumulado || '',
    inicio: extra.inicio !== 'nao_informado' ? extra.inicio : base.inicio,
    duracao: extra.duracao !== 'nao_informado' ? extra.duracao : base.duracao,
    piora: extra.piora !== 'nao_informado' ? extra.piora : base.piora,
    intensidade: extra.intensidade !== 'nao_informado' ? extra.intensidade : base.intensidade,

    gestante: preferirComNegacao(base.gestante, extra.gestante, 'nao_informado', 'nao'),
    pos_parto: preferirComNegacao(base.pos_parto, extra.pos_parto, 'nao_informado', 'nao'),

    falta_de_ar: preferirFlagComNegacao(base.falta_de_ar, extra.falta_de_ar),
    dor_no_peito: preferirFlagComNegacao(base.dor_no_peito, extra.dor_no_peito),
    desmaio: preferirFlagComNegacao(base.desmaio, extra.desmaio),
    confusao: preferirFlagComNegacao(base.confusao, extra.confusao),
    sangramento: preferirFlagComNegacao(base.sangramento, extra.sangramento),
    febre: preferirFlagComNegacao(base.febre, extra.febre),
    vomitos: preferirFlagComNegacao(base.vomitos, extra.vomitos),
    trauma: preferirFlagComNegacao(base.trauma, extra.trauma),
    exposicao_intoxicacao: preferirFlagComNegacao(base.exposicao_intoxicacao, extra.exposicao_intoxicacao),
    fala_frases: preferirFlagComNegacao(base.fala_frases, extra.fala_frases),
    labios_roxos: preferirFlagComNegacao(base.labios_roxos, extra.labios_roxos),
    consegue_beber: preferirFlagComNegacao(base.consegue_beber, extra.consegue_beber),
    alergia_grave: preferirFlagComNegacao(base.alergia_grave, extra.alergia_grave),

    risco_mental: ORDEM_RISCO[extra.risco_mental] > ORDEM_RISCO[base.risco_mental]
      ? extra.risco_mental
      : base.risco_mental,

    autodiagnostico_grave: extra.autodiagnostico_grave ?? base.autodiagnostico_grave,

    informacao_insuficiente: extra.informacao_insuficiente && base.informacao_insuficiente,
  };
}