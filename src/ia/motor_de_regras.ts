
import { registrarDecisao } from './auditoria.js';
import { contemAlgum, normalizarTexto } from './normalizar.js';
import { VERSAO_REGRAS, type DecisaoRegras, type RelatoEstruturado } from './tipos.js';

import emergencias from '../regras/emergencias.json';
import obstetricia from '../regras/obstetricia.json';
import saudeMental from '../regras/saude_mental.json';
import vulneraveis from '../regras/grupos_vulneraveis.json';
import urgencias from '../regras/urgencias.json';
import baixaGravidade from '../regras/baixa_gravidade.json';

type RegraJson = {
  id: string;
  quando: string[];
};

type RegrasContainer = {
  versao: string;
  regras: RegraJson[];
};

function flagTriStateToBoolean(valor: boolean | 'nao_informado'): boolean {
  return valor === true;
}

function casaRegra(texto: string, regras: RegraJson[]): RegraJson | null {
  for (const regra of regras) {
    if (regra.quando.some((palavra) => texto.includes(normalizarTexto(palavra)))) {
      return regra;
    }
  }
  return null;
}

function corpus(relato: RelatoEstruturado, textoOriginal: string = ''): string {
  const partes: string[] = [
    textoOriginal,
    ...relato.sintomas,
    ...relato.sinais_alerta,
    ...(relato.sinais_obstetricos || []),
    ...(relato.sinais_trauma || []),
  ];
  return normalizarTexto(partes.filter(Boolean).join(' '));
}

function verificarEmergenciaObstetrica(relato: RelatoEstruturado, texto: string): DecisaoRegras | null {
  const sinais = relato.sinais_obstetricos || [];
  if (relato.gestante === 'sim' || relato.sinais_alerta.includes('gestante')) {
    if (
      sinais.includes('pre_eclampsia') ||
      sinais.includes('perda_liquido_amniotico') ||
      sinais.includes('contracoes') ||
      sinais.includes('sangramento_obstetrico') ||
      (sinais.includes('pressao_alta') && contemAlgum(texto, ['dor de cabeca intensa', 'enxaqueca', 'visao turva']))
    ) {
      return {
        categoria_interna: 'emergencia',
        destino: 'SAMU_192_PRONTO_SOCORRO',
        resposta_id: 'obstetricia_001',
        regra_acionada: 'obstetricia_emergencia',
        versao_regras: VERSAO_REGRAS,
      };
    }
  }
  return null;
}

function verificarTraumaGrave(relato: RelatoEstruturado, texto: string): DecisaoRegras | null {
  const sinais = relato.sinais_trauma || [];
  if (
    sinais.includes('trauma_automobilistico') ||
    sinais.includes('queda_altura') ||
    contemAlgum(texto, ['atropelamento', 'acidente de carro', 'colisao', 'capotamento', 'queda de altura'])
  ) {
    return {
      categoria_interna: 'emergencia',
      destino: 'SAMU_192_PRONTO_SOCORRO',
      resposta_id: 'emergencia_001',
      regra_acionada: 'trauma_grave_mecanismo',
      versao_regras: VERSAO_REGRAS,
    };
  }

  if (relato.exposicao_intoxicacao === true && contemAlgum(texto, ['grave', 'intenso', 'forte', 'perigo', 'urgente'])) {
    return {
      categoria_interna: 'emergencia',
      destino: 'SAMU_192_PRONTO_SOCORRO',
      resposta_id: 'emergencia_001',
      regra_acionada: 'intoxicacao_grave',
      versao_regras: VERSAO_REGRAS,
    };
  }

  if (relato.sintomas.includes('queimadura') && contemAlgum(texto, ['extensa', 'grande', 'grave', '2 grau', '3 grau'])) {
    return {
      categoria_interna: 'emergencia',
      destino: 'SAMU_192_PRONTO_SOCORRO',
      resposta_id: 'emergencia_001',
      regra_acionada: 'queimadura_grave',
      versao_regras: VERSAO_REGRAS,
    };
  }
  return null;
}

export function aplicarMotor(relato: RelatoEstruturado, textoOriginal?: string): DecisaoRegras {
  const texto = corpus(relato, textoOriginal || '');

  // 1. Emergências obstétricas
  const obst = verificarEmergenciaObstetrica(relato, texto);
  if (obst) return obst;

  // 2. Trauma grave e intoxicação
  const trauma = verificarTraumaGrave(relato, texto);
  if (trauma) return trauma;

  // 3. Hipertensão associada a sinais de alarme neurológico/cardíaco (Regra 8)
  const temPressao = contemAlgum(texto, ['pressao alta', 'pressao subiu', 'pressao elevada', 'hipertensao']);
  if (
    temPressao &&
    contemAlgum(texto, ['dor de cabeca', 'cabeca explodindo', 'visao turva', 'visao embacada', 'dor no peito', 'falta de ar', 'vomito'])
  ) {
    return {
      categoria_interna: 'emergencia',
      destino: 'SAMU_192_PRONTO_SOCORRO',
      resposta_id: 'emergencia_001',
      regra_acionada: 'emergencia_pressao_sintomatica',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 4. Regras gerais de emergência (SAMU / PS)
  const regrasEmergencia = (emergencias as RegrasContainer).regras;
  const emerg = casaRegra(texto, regrasEmergencia);
  if (emerg) {
    return {
      categoria_interna: 'emergencia',
      destino: 'SAMU_192_PRONTO_SOCORRO',
      resposta_id: 'emergencia_001',
      regra_acionada: emerg.id,
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 5. Regra 10: Bebê com febre (prioridade pediátrica hospitalar)
  if (relato.idade_grupo === 'bebe' && flagTriStateToBoolean(relato.febre)) {
    return {
      categoria_interna: 'emergencia',
      destino: 'SAMU_192_PRONTO_SOCORRO',
      resposta_id: 'pediatria_emergencia_001',
      regra_acionada: 'pediatria_bebe_febre_grave',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 6. Regra 12.1: Saúde mental com risco iminente
  if (relato.risco_mental === 'iminente') {
    return {
      categoria_interna: 'emergencia',
      destino: 'SAMU_192_PRONTO_SOCORRO',
      resposta_id: 'mental_emergencia_001',
      regra_acionada: 'mental_risco_iminente',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 7. Regra 12.2: Saúde mental sem risco imediato (CAPS)
  const regrasSaudeMental = (saudeMental as RegrasContainer).regras;
  if (relato.risco_mental === 'sem_risco_imediato' || casaRegra(texto, regrasSaudeMental)) {
    return {
      categoria_interna: 'saude_mental_sem_risco_imediato',
      destino: 'CAPS_OU_SERVICO_DE_SAUDE_MENTAL',
      resposta_id: 'mental_caps_001',
      regra_acionada: 'mental_sem_risco_imediato',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 8. Picada de animal peçonhento (Regra 8: UPA 24h imediata)
  if (contemAlgum(texto, ['escorpiao', 'aranha', 'cobra', 'peconhento', 'jararaca', 'cascavel', 'coral'])) {
    return {
      categoria_interna: 'urgencia',
      destino: 'UPA_24H',
      resposta_id: 'upa_001',
      regra_acionada: 'urgencia_animal_peconhento',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 9. Sintoma urinário com febre ou dor lombar/costas (Regra 8: UPA 24h)
  const temUrinario = contemAlgum(texto, ['urinar', 'xixi', 'ardor ao urinar', 'dor ao urinar', 'queimacao ao urinar', 'infeccao urinaria']);
  if (
    temUrinario &&
    (flagTriStateToBoolean(relato.febre) || contemAlgum(texto, ['dor nas costas', 'dor lombar', 'dor nos rins', 'febre']))
  ) {
    return {
      categoria_interna: 'urgencia',
      destino: 'UPA_24H',
      resposta_id: 'upa_001',
      regra_acionada: 'urgencia_urinario_com_alarme',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 10. Febre com prostração ou persistente (UPA 24h)
  if (
    flagTriStateToBoolean(relato.febre) &&
    (contemAlgum(texto, ['fraqueza', 'prostracao', 'liquidos']) ||
      /[3-9]|tres|quatro|cinco/.test(normalizarTexto(relato.duracao)))
  ) {
    return {
      categoria_interna: 'urgencia',
      destino: 'UPA_24H',
      resposta_id: 'upa_001',
      regra_acionada: 'urgencia_febre_prostracao',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 11. Urgências gerais (UPA 24h)
  const regrasUrgencias = (urgencias as RegrasContainer).regras;
  const urgencia = casaRegra(texto, regrasUrgencias);
  if (urgencia) {
    return {
      categoria_interna: 'urgencia',
      destino: 'UPA_24H',
      resposta_id: 'upa_001',
      regra_acionada: urgencia.id,
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 12. Grupos vulneráveis / rotina estável (UBS)
  const regrasVulneraveis = (vulneraveis as RegrasContainer).regras;
  const vulneravel = casaRegra(texto, regrasVulneraveis);
  if (vulneravel) {
    return {
      categoria_interna: 'baixa_gravidade',
      destino: 'UBS_CLINICA_DA_FAMILIA',
      resposta_id: 'ubs_001',
      regra_acionada: vulneravel.id,
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 13. Baixa gravidade (UBS)
  const regrasBaixa = (baixaGravidade as RegrasContainer).regras;
  const baixa = casaRegra(texto, regrasBaixa);
  if (baixa || (!relato.informacao_insuficiente && relato.sintomas.length > 0)) {
    return {
      categoria_interna: 'baixa_gravidade',
      destino: 'UBS_CLINICA_DA_FAMILIA',
      resposta_id: 'ubs_001',
      regra_acionada: baixa?.id ?? 'baixa_padrao',
      versao_regras: VERSAO_REGRAS,
    };
  }

  // 14. Fallback seguro
  return {
    categoria_interna: 'informacao_insuficiente',
    destino: 'FALLBACK',
    resposta_id: 'fallback_001',
    regra_acionada: 'informacao_insuficiente',
    versao_regras: VERSAO_REGRAS,
  };
}