import { contemAlgum, normalizarTexto } from './normalizar.js';
import { VERSAO_REGRAS, type DecisaoRegras, type RelatoEstruturado, type Nivel } from './tipos.js';
import emergencias from '../regras/emergencias.json';
import saudeMental from '../regras/saude_mental.json';
import urgencias from '../regras/urgencias.json';
import baixaGravidade from '../regras/baixa_gravidade.json';
import gruposVulneraveis from '../regras/grupos_vulneraveis.json';

type RegraJson = { id: string; quando: string[] };
type RegrasContainer = { versao: string; regras: RegraJson[] };

function flag(v: boolean | 'nao_informado' | undefined): boolean { return v === true; }
function flagFalse(v: boolean | 'nao_informado' | undefined): boolean { return v === false; }

function decisao(
  regra: string, categoria: DecisaoRegras['categoria_interna'],
  destino: DecisaoRegras['destino'], resposta_id: string,
  nivel: Nivel, motivos: string[],
): DecisaoRegras {
  return {
    categoria_interna: categoria,
    destino,
    resposta_id,
    regra_acionada: regra,
    versao_regras: VERSAO_REGRAS,
    nivel,
    motivos,
  };
}

// [RESTAURADO] Trauma grave com mecanismo + queimadura extensa + intoxicação grave
function verificarTraumaGrave(R: RelatoEstruturado, texto: string): DecisaoRegras | null {
  const sinais = R.sinais_trauma || [];

  // Ferimento penetrante (faca/tiro)
  if (sinais.includes('ferimento_perfurante')) {
    return decisao('trauma_penetrante', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['ferimento por arma']);
  }

  // Trauma crânio-encefálico com sinal
  if (sinais.includes('trauma_craniano') &&
      (R.idade_grupo === 'idoso' || R.confusao === true || (R.sinais_neurologicos || []).length > 0)) {
    return decisao('trauma_craniano_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['trauma craniano com sinal']);
  }

  // Mecanismo de trauma grave
  if (sinais.includes('trauma_automobilistico') || sinais.includes('queda_altura') ||
      contemAlgum(texto, ['atropelamento', 'acidente de carro', 'colisao', 'capotamento', 'queda de altura'])) {
    return decisao('trauma_grave_mecanismo', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['mecanismo de trauma grave']);
  }

  // [RESTAURADO] Intoxicação grave com qualificador
  if (R.exposicao_intoxicacao === true &&
      contemAlgum(texto, ['grave', 'intenso', 'forte', 'perigo', 'urgente', 'muito'])) {
    return decisao('intoxicacao_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['intoxicação grave']);
  }

  // [RESTAURADO] Queimadura extensa/grave
  if (R.sintomas.includes('queimadura') &&
      contemAlgum(texto, ['extensa', 'grande', 'grave', '2 grau', '3 grau', 'muito']))
  {
    return decisao('queimadura_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['queimadura grave']);
  }

  return null;
}

// [RESTAURADO] Emergência obstétrica específica
function verificarEmergenciaObstetrica(R: RelatoEstruturado, texto: string): DecisaoRegras | null {
  if (R.gestante !== 'sim' && R.pos_parto !== 'sim') return null;

  const sinais = R.sinais_obstetricos || [];
  const temSinalObstetrico =
    sinais.includes('pre_eclampsia') ||
    sinais.includes('perda_liquido_amniotico') ||
    sinais.includes('contracoes') ||
    sinais.includes('sangramento_obstetrico') ||
    (sinais.includes('pressao_alta') &&
      contemAlgum(texto, ['dor de cabeca intensa', 'enxaqueca', 'visao turva', 'visao embacada']));

  if (temSinalObstetrico) {
    return decisao('obstetricia_emergencia', 'emergencia', 'MATERNIDADE_PRONTO_SOCORRO_OBSTETRICO',
      'obstetricia_001', 'SAMU_AGORA', ['sinal obstétrico de risco']);
  }
  return null;
}

export function aplicarMotor(relato: RelatoEstruturado, textoOriginal?: string): DecisaoRegras {
  const R = relato;
  const texto = normalizarTexto([
    R.texto_original_acumulado || '',
    textoOriginal || '',
    ...R.sintomas,
    ...R.sinais_alerta,
  ].join(' '));

  // ══════════════ NÍVEL 1 — CRÍTICO (SAMU) ══════════════

  // 1. Risco mental iminente
  if (R.risco_mental === 'iminente') {
    return decisao('mental_iminente', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'mental_emergencia_001', 'SAMU_AGORA', ['risco de autoagressão']);
  }

  // 2-5. Trauma grave (penetrante, TCE, mecanismo, intoxicação, queimadura)
  const trauma = verificarTraumaGrave(R, texto);
  if (trauma) return trauma;

  // 6. AVC
  if ((R.sinais_neurologicos || []).length > 0) {
    return decisao('avc_suspeito', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['sinais neurológicos súbitos']);
  }

  // 7. Anafilaxia
  if (R.alergia_grave === true) {
    return decisao('anafilaxia', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['reação alérgica grave']);
  }

  // 8. Falta de ar crítica (não fala frases / lábios roxos)
  if (R.falta_de_ar === true && (flagFalse(R.fala_frases) || flag(R.labios_roxos))) {
    return decisao('resp_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['falta de ar com critério']);
  }

  // 9. Dor torácica com sinal associado
  if (R.dor_no_peito === true && (R.falta_de_ar === true || R.desmaio === true || R.confusao === true)) {
    return decisao('dor_toracica_com_sinais', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['dor torácica com sinais']);
  }

  // 10. Autodiagnóstico grave
  if (R.autodiagnostico_grave) {
    return decisao(`autodiag_${R.autodiagnostico_grave}`, 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', [`relato de ${R.autodiagnostico_grave}`]);
  }

  // 11. Inconsciência
  if (R.desmaio === true && R.confusao === true) {
    return decisao('inconsciencia', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['alteração grave de consciência']);
  }

  // [RESTAURADO] Hipertensão com sinal grave
  const temPressao = contemAlgum(texto, ['pressao alta', 'pressao subiu', 'pressao elevada', 'hipertensao']);
  if (temPressao &&
      contemAlgum(texto, ['dor de cabeca', 'cabeca explodindo', 'visao turva', 'visao embacada', 'dor no peito', 'falta de ar', 'vomito'])) {
    return decisao('emergencia_pressao_sintomatica', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['pressão alta com sinal']);
  }

  // 12. Obstétrica crítica
  const obst = verificarEmergenciaObstetrica(R, texto);
  if (obst) return obst;

  // 13. Emergências do JSON
  for (const regra of (emergencias as RegrasContainer).regras) {
    if (regra.quando.some((p) => contemAlgum(texto, [p]))) {
      return decisao(regra.id, 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
        'emergencia_001', 'SAMU_AGORA', [regra.id]);
    }
  }

  // 14. Bebê com febre
  if (R.idade_grupo === 'bebe' && R.febre === true) {
    return decisao('pediatria_bebe_febre', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'pediatria_emergencia_001', 'SAMU_AGORA', ['bebê com febre']);
  }

  // ══════════════ NÍVEL 2 — UPA AGORA ══════════════

  // Criança que não bebe
  if ((R.idade_grupo === 'bebe' || R.idade_grupo === 'crianca') && flagFalse(R.consegue_beber)) {
    return decisao('pediatria_desidratacao', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['criança que não bebe']);
  }

  // Falta de ar isolada (sem gravidade)
  if (R.falta_de_ar === true) {
    return decisao('falta_de_ar_isolada', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['falta de ar']);
  }

  // Sinal de alarme isolado
  if (R.dor_no_peito === true || R.desmaio === true || R.confusao === true || R.sangramento === true) {
    return decisao('sinal_alarme_isolado', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['sinal de alarme']);
  }

  // Trauma mecânico (auto / queda altura) sem gravidade
  if ((R.sinais_trauma || []).some((s) => ['trauma_automobilistico', 'queda_altura'].includes(s))) {
    return decisao('trauma_mecanismo', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['trauma com mecanismo de risco']);
  }

  // Animal peçonhento
  if (R.sintomas.some((s) => /picada de animal peçonhento/.test(s))) {
    return decisao('animal_peconhento', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['picada de animal peçonhento']);
  }

  // Sintoma urinário com alarme
  if (R.sintomas.some((s) => /sintoma urinário/.test(s)) &&
      (R.febre === true || contemAlgum(texto, ['dor nas costas', 'dor lombar', 'dor nos rins']))) {
    return decisao('urinario_com_febre', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['sintoma urinário com alarme']);
  }

  // Queimadura não-grave
  if (R.sintomas.includes('queimadura')) {
    return decisao('queimadura', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['queimadura']);
  }

  // Intoxicação sem qualificador grave
  if (R.exposicao_intoxicacao === true) {
    return decisao('intoxicacao', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['intoxicação']);
  }

  // Urgências do JSON
  for (const regra of (urgencias as RegrasContainer).regras) {
    if (regra.quando.some((p) => contemAlgum(texto, [p]))) {
      return decisao(regra.id, 'urgencia', 'UPA_24H', 'upa_001', 'UPA_AGORA', [regra.id]);
    }
  }

  // Intensidade / piora
  if (R.sintomas.length > 0 && (R.intensidade === 'intensa' || R.piora === 'sim')) {
    return decisao('queixa_intensa_ou_piora', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['intensidade ou piora']);
  }

  // ══════════════ NÍVEL 3 — HOJE ══════════════

  // Febre prolongada
  const durNum = parseInt(R.duracao.match(/\d+/)?.[0] || '0', 10);
  const durLonga = durNum >= 3 || /tres|quatro|cinco|seis|sete|oito|nove|dez/.test(normalizarTexto(R.duracao));
  if (R.febre === true && durLonga) {
    return decisao('febre_persistente', 'urgencia', 'UPA_24H',
      'upa_001', 'HOJE', ['febre prolongada']);
  }

  // Saúde mental sem risco
  if (R.risco_mental === 'sem_risco_imediato') {
    return decisao('mental_sem_risco_imediato', 'saude_mental_sem_risco_imediato',
      'CAPS_OU_SERVICO_DE_SAUDE_MENTAL', 'mental_caps_001', 'HOJE', ['sofrimento psíquico']);
  }
  for (const regra of (saudeMental as RegrasContainer).regras) {
    if (regra.id !== 'mental_sem_risco_imediato') continue;
    if (regra.quando.some((p) => contemAlgum(texto, [p]))) {
      return decisao('mental_sem_risco_imediato', 'saude_mental_sem_risco_imediato',
        'CAPS_OU_SERVICO_DE_SAUDE_MENTAL', 'mental_caps_001', 'HOJE', [regra.id]);
    }
  }

  // ══════════════ NÍVEL 4 — AGENDAR ══════════════

  for (const regra of (gruposVulneraveis as RegrasContainer).regras) {
    if (regra.quando.some((p) => contemAlgum(texto, [p]))) {
      return decisao(regra.id, 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
        'ubs_001', 'AGENDAR', [regra.id]);
    }
  }
  for (const regra of (baixaGravidade as RegrasContainer).regras) {
    if (regra.quando.some((p) => contemAlgum(texto, [p]))) {
      return decisao(regra.id, 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
        'ubs_001', 'AGENDAR', [regra.id]);
    }
  }

  if (R.sintomas.length > 0 && !R.informacao_insuficiente) {
    return decisao('baixa_padrao', 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
      'ubs_001', 'AGENDAR', ['queixa estável']);
  }

  return decisao('informacao_insuficiente', 'informacao_insuficiente', 'FALLBACK',
    'fallback_001', 'HOJE', ['informação insuficiente']);
}