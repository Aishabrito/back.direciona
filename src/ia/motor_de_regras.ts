import { contemAlgum, normalizarTexto } from './normalizar.js';
import {
  VERSAO_REGRAS,
  type DecisaoRegras, type RelatoEstruturado, type Nivel,
} from './tipos.js';

import emergencias from '../regras/emergencias.json';
import saudeMental from '../regras/saude_mental.json';
import urgencias from '../regras/urgencias.json';
import baixaGravidade from '../regras/baixa_gravidade.json';
import gruposVulneraveis from '../regras/grupos_vulneraveis.json';

type RegraJson = { id: string; quando: string[] };
type RegrasContainer = { versao: string; regras: RegraJson[] };

function flag(v: boolean | 'nao_informado' | undefined): boolean { return v === true; }
function flagFalse(v: boolean | 'nao_informado' | undefined): boolean { return v === false; }

function montarDecisao(
  regra: string,
  categoria: DecisaoRegras['categoria_interna'],
  destino: DecisaoRegras['destino'],
  resposta_id: string,
  nivel: Nivel,
  motivos: string[],
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

export function aplicarMotor(relato: RelatoEstruturado, _textoOriginal?: string): DecisaoRegras {
  const R = relato;

  // ══════════════ NÍVEL 1 — SAMU AGORA (crítico) ══════════════

  // 1. Risco mental iminente
  if (R.risco_mental === 'iminente') {
    return montarDecisao('mental_iminente', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'mental_emergencia_001', 'SAMU_AGORA', ['risco de autoagressão']);
  }

  // 2. Trauma penetrante (faca/tiro)
  if ((R.sinais_trauma || []).includes('ferimento_perfurante')) {
    return montarDecisao('trauma_penetrante', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['ferimento por arma']);
  }

  // 3. Trauma craniano com sinal associado / idoso
  if ((R.sinais_trauma || []).includes('trauma_craniano') &&
      (R.idade_grupo === 'idoso' || R.confusao === true || (R.sinais_neurologicos || []).length > 0)) {
    return montarDecisao('trauma_craniano_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['trauma craniano com sinal']);
  }

  // 4. AVC (sinais neurológicos súbitos)
  if ((R.sinais_neurologicos || []).length > 0) {
    return montarDecisao('avc_suspeito', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['sinais neurológicos súbitos']);
  }

  // 5. Anafilaxia
  if (R.alergia_grave === true) {
    return montarDecisao('anafilaxia', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['reação alérgica grave']);
  }

  // 6. Falta de ar com critério crítico
  if (R.falta_de_ar === true && (flagFalse(R.fala_frases) || flag(R.labios_roxos))) {
    return montarDecisao('resp_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['falta de ar com critério']);
  }

  // 7. Dor torácica com sinal associado
  if (R.dor_no_peito === true && (R.falta_de_ar === true || R.desmaio === true || R.confusao === true)) {
    return montarDecisao('dor_toracica_com_sinais', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['dor torácica com sinais']);
  }

  // 8. Autodiagnóstico grave ("acho que é infarto")
  if (R.autodiagnostico_grave) {
    return montarDecisao(`autodiag_${R.autodiagnostico_grave}`, 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', [`relato de ${R.autodiagnostico_grave}`]);
  }

  // 9. Inconsciência (desmaio + confusão)
  if (R.desmaio === true && R.confusao === true) {
    return montarDecisao('inconsciencia', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['alteração grave de consciência']);
  }

  // 10. Obstétrica com sinal
  if ((R.sinais_obstetricos || []).length > 0) {
    return montarDecisao('obstetricia_critica', 'emergencia', 'MATERNIDADE_PRONTO_SOCORRO_OBSTETRICO',
      'obstetricia_001', 'SAMU_AGORA', ['sinal obstétrico de risco']);
  }

  // 11. Emergências do JSON
  const corpusTexto = normalizarTexto([
    R.texto_original_acumulado || '',
    ...R.sintomas,
    ...R.sinais_alerta,
  ].join(' '));
  const regrasEmergencia = (emergencias as RegrasContainer).regras;
  for (const regra of regrasEmergencia) {
    if (regra.quando.some((p) => corpusTexto.includes(normalizarTexto(p)))) {
      return montarDecisao(regra.id, 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
        'emergencia_001', 'SAMU_AGORA', [regra.id]);
    }
  }

  // 12. Bebê com febre
  if (R.idade_grupo === 'bebe' && R.febre === true) {
    return montarDecisao('pediatria_bebe_febre', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'pediatria_emergencia_001', 'SAMU_AGORA', ['bebê com febre']);
  }

  // ══════════════ NÍVEL 2 — UPA AGORA ══════════════

  // 13. Criança que não bebe
  if ((R.idade_grupo === 'bebe' || R.idade_grupo === 'crianca') && flagFalse(R.consegue_beber)) {
    return montarDecisao('pediatria_desidratacao', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['criança que não bebe']);
  }

  // 14. Falta de ar isolada
  if (R.falta_de_ar === true) {
    return montarDecisao('falta_de_ar_isolada', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['falta de ar']);
  }

  // 15. Sinal de alerta isolado
  if (R.dor_no_peito === true || R.desmaio === true || R.confusao === true || R.sangramento === true) {
    return montarDecisao('sinal_alarme_isolado', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['sinal de alarme']);
  }

  // 16. Trauma mecânico (auto / queda altura)
  if ((R.sinais_trauma || []).some((s) => ['trauma_automobilistico', 'queda_altura'].includes(s))) {
    return montarDecisao('trauma_mecanismo', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['trauma com mecanismo de risco']);
  }

  // 17. Hipertensão com sinal
  const temPressao = contemAlgum(corpusTexto, ['pressao alta', 'pressao subiu', 'hipertensao']);
  if (temPressao && contemAlgum(corpusTexto, ['dor de cabeca', 'visao turva', 'visao embacada', 'vomito'])) {
    return montarDecisao('hipertensao_sintomatica', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['pressão alta com sintoma']);
  }

  // 18. Animal peçonhento
  if (R.sintomas.some((s) => /picada de animal peçonhento/.test(s))) {
    return montarDecisao('animal_peconhento', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['picada de animal peçonhento']);
  }

  // 19. Sintoma urinário com febre ou dor lombar
  if (R.sintomas.some((s) => /sintoma urinário/.test(s)) &&
      (R.febre === true || contemAlgum(corpusTexto, ['dor nas costas', 'dor lombar', 'dor nos rins']))) {
    return montarDecisao('urinario_com_febre', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['sintoma urinário com alarme']);
  }

  // 20. Queimadura
  if (R.sintomas.includes('queimadura')) {
    return montarDecisao('queimadura', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['queimadura']);
  }

  // 21. Urgências do JSON
  const regrasUrgencias = (urgencias as RegrasContainer).regras;
  for (const regra of regrasUrgencias) {
    if (regra.quando.some((p) => corpusTexto.includes(normalizarTexto(p)))) {
      return montarDecisao(regra.id, 'urgencia', 'UPA_24H',
        'upa_001', 'UPA_AGORA', [regra.id]);
    }
  }

  // ══════════════ NÍVEL 3 — HOJE (UBS no mesmo dia se piorar) ══════════════

  // 22. Febre prolongada
  const durNum = parseInt(R.duracao.match(/\d+/)?.[0] || '0', 10);
  const durLonga = durNum >= 3 || /tres|quatro|cinco|seis|sete|oito|nove|dez/.test(normalizarTexto(R.duracao));
  if (R.febre === true && durLonga) {
    return montarDecisao('febre_persistente', 'urgencia', 'UPA_24H',
      'upa_001', 'HOJE', ['febre prolongada']);
  }

  // 23. Sintoma agudo de baixa gravidade
  if (R.sintomas.length > 0 && R.intensidade !== 'intensa' && R.piora !== 'sim') {
    return montarDecisao('sintoma_leve', 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
      'ubs_001', 'HOJE', ['sintoma leve']);
  }

  // ══════════════ NÍVEL 4 — AGENDAR (UBS rotina) ══════════════

  // 24. Saúde mental sem risco
  const regrasMental = (saudeMental as RegrasContainer).regras;
  for (const regra of regrasMental) {
    if (regra.id !== 'mental_sem_risco_imediato') continue;
    if (regra.quando.some((p) => corpusTexto.includes(normalizarTexto(p)))) {
      return montarDecisao('mental_sem_risco_imediato', 'saude_mental_sem_risco_imediato',
        'CAPS_OU_SERVICO_DE_SAUDE_MENTAL', 'mental_caps_001', 'HOJE', ['sofrimento psíquico']);
    }
  }
  if (R.risco_mental === 'sem_risco_imediato') {
    return montarDecisao('mental_sem_risco_imediato', 'saude_mental_sem_risco_imediato',
      'CAPS_OU_SERVICO_DE_SAUDE_MENTAL', 'mental_caps_001', 'HOJE', ['sofrimento psíquico']);
  }

  // 25. Grupos vulneráveis (rotina)
  const regrasVulneraveis = (gruposVulneraveis as RegrasContainer).regras;
  for (const regra of regrasVulneraveis) {
    if (regra.quando.some((p) => corpusTexto.includes(normalizarTexto(p)))) {
      return montarDecisao(regra.id, 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
        'ubs_001', 'AGENDAR', [regra.id]);
    }
  }

  // 26. Baixa gravidade (JSON)
  const regrasBaixa = (baixaGravidade as RegrasContainer).regras;
  for (const regra of regrasBaixa) {
    if (regra.quando.some((p) => corpusTexto.includes(normalizarTexto(p)))) {
      return montarDecisao(regra.id, 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
        'ubs_001', 'AGENDAR', [regra.id]);
    }
  }

  // 27. Queixa estável
  if (R.sintomas.length > 0 && !R.informacao_insuficiente) {
    return montarDecisao('baixa_padrao', 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
      'ubs_001', 'AGENDAR', ['queixa estável']);
  }

  // 28. Fallback — informação insuficiente
  return montarDecisao('informacao_insuficiente', 'informacao_insuficiente', 'FALLBACK',
    'fallback_001', 'HOJE', ['informação insuficiente']);
}