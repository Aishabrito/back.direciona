
import type { RelatoEstruturado } from './tipos.js';

// ═══════════════════════════════════════════════════════════
// CRITÉRIOS DE EMERGÊNCIA (SAMU AGORA)
// ═══════════════════════════════════════════════════════════
// Cada critério é uma função pura. Se verdadeiro, a decisão é SAMU.
// A ordem IMPORTA: os mais graves primeiro (para log/motivo).

export type CriterioCritico = {
  id: string;
  motivo: string;
  testar: (r: RelatoEstruturado) => boolean;
};

export const CRITERIOS_SAMU: CriterioCritico[] = [
  {
    id: 'mental_iminente',
    motivo: 'risco de autoagressão',
    testar: (r) => r.risco_mental === 'iminente',
  },
  {
    id: 'violencia',
    motivo: 'situação de violência',
    testar: (r) =>
      r.sinais_alerta.includes('violencia_sexual') ||
      r.sinais_alerta.includes('violencia_domestica'),
  },
  {
    id: 'trauma_penetrante',
    motivo: 'ferimento por arma',
    testar: (r) => r.sinais_trauma.includes('ferimento_perfurante'),
  },
  {
    id: 'trauma_craniano_grave',
    motivo: 'trauma craniano com sinal',
    testar: (r) =>
      r.sinais_trauma.includes('trauma_craniano') &&
      (r.idade_grupo === 'idoso' ||
        r.confusao === true ||
        r.sinais_neurologicos.length > 0),
  },
  {
    id: 'avc_suspeito',
    motivo: 'sinais neurológicos súbitos',
    testar: (r) => r.sinais_neurologicos.length > 0,
  },
  {
    id: 'anafilaxia',
    motivo: 'reação alérgica grave',
    testar: (r) => r.alergia_grave === true,
  },
  {
    id: 'convulsao',
    motivo: 'convulsão',
    testar: (r) => r.sinais_alerta.includes('convulsao'),
  },
  {
    id: 'resp_grave',
    motivo: 'falta de ar com critério',
    testar: (r) =>
      r.falta_de_ar === true &&
      (r.fala_frases === false || r.labios_roxos === true),
  },
  {
    id: 'dor_toracica_com_sinais',
    motivo: 'dor torácica com sinais',
    testar: (r) =>
      r.dor_no_peito === true &&
      (r.falta_de_ar === true || r.desmaio === true || r.confusao === true),
  },
  {
    id: 'autodiagnostico_grave',
    motivo: 'relato de condição grave',
    testar: (r) => r.autodiagnostico_grave !== null,
  },
  {
    id: 'inconsciencia',
    motivo: 'alteração grave de consciência',
    testar: (r) => r.desmaio === true && r.confusao === true,
  },
  {
    id: 'obstetricia_critica',
    motivo: 'sinal obstétrico de risco',
    testar: (r) => r.sinais_obstetricos.length > 0,
  },
  {
    id: 'idoso_queda_confusao',
    motivo: 'idoso com queda e alteração de consciência',
    testar: (r) =>
      r.idade_grupo === 'idoso' &&
      r.trauma === true &&
      (r.confusao === true || r.desmaio === true),
  },
  {
    id: 'pediatria_bebe_febre',
    motivo: 'bebê com febre',
    testar: (r) => r.idade_grupo === 'bebe' && r.febre === true,
  },
];

// ═══════════════════════════════════════════════════════════
// CRITÉRIOS DE ALERTA (uma pergunta antes de decidir)
// ═══════════════════════════════════════════════════════════

export const CRITERIOS_ALERTA: CriterioCritico[] = [
  {
    id: 'falta_de_ar_ambigua',
    motivo: 'falta de ar sem qualificador',
    testar: (r) =>
      r.falta_de_ar === true &&
      r.fala_frases === 'nao_informado' &&
      r.labios_roxos === 'nao_informado',
  },
  {
    id: 'trauma_mecanismo',
    motivo: 'trauma com mecanismo de risco',
    testar: (r) =>
      r.sinais_trauma.includes('trauma_automobilistico') ||
      r.sinais_trauma.includes('queda_altura') ||
      r.sinais_trauma.includes('trauma_craniano'),
  },
  {
    id: 'dor_toracica_isolada',
    motivo: 'dor no peito sem sinal associado',
    testar: (r) => r.dor_no_peito === true && r.falta_de_ar !== true,
  },
  {
    id: 'sangramento',
    motivo: 'sangramento',
    testar: (r) => r.sangramento === true,
  },
  {
    id: 'confusao_isolada',
    motivo: 'confusão',
    testar: (r) => r.confusao === true,
  },
];

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

export function encontrarCriterioCritico(
  r: RelatoEstruturado,
): CriterioCritico | null {
  for (const c of CRITERIOS_SAMU) {
    if (c.testar(r)) return c;
  }
  return null;
}

export function encontrarCriterioAlerta(
  r: RelatoEstruturado,
): CriterioCritico | null {
  for (const c of CRITERIOS_ALERTA) {
    if (c.testar(r)) return c;
  }
  return null;
}

export type NivelAlerta = 'critico' | 'alerta' | 'normal';

export function classificarNivel(r: RelatoEstruturado): NivelAlerta {
  if (encontrarCriterioCritico(r)) return 'critico';
  if (encontrarCriterioAlerta(r)) return 'alerta';
  return 'normal';
}