import { contemAlgum, normalizarTexto } from './normalizar.js';
import { VERSAO_REGRAS, type DecisaoRegras, type RelatoEstruturado, type Nivel } from './tipos.js';
import emergencias from '../regras/emergencias.json';
import saudeMental from '../regras/saude_mental.json';
import urgencias from '../regras/urgencias.json';
import baixaGravidade from '../regras/baixa_gravidade.json';
import gruposVulneraveis from '../regras/grupos_vulneraveis.json';

type RegraJson = { id: string; quando: string[] };
type RegrasContainer = { versao: string; regras: RegraJson[] };

const PALAVRA_NUM: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
};
function duracaoEmDias(duracao: string): number {
  const n = normalizarTexto(duracao || '');
  const m = n.match(/(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s*(hora|horas|dia|dias|semana|semanas|mes|meses)/);
  if (!m) return 0;
  const qtd = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : PALAVRA_NUM[m[1]] ?? 0;
  const un = m[2];
  if (un.startsWith('hora')) return qtd / 24;
  if (un.startsWith('dia')) return qtd;
  if (un.startsWith('semana')) return qtd * 7;
  return qtd * 30;
}

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

// [FIX] Intoxicação com QUANTIDADE (2 caixas, 1 vidro...) já é grave por si só
const QUANTIDADE_INTOX = /\b\d+\s*(caixa|cartela|vidro|garrafa|frasco|comprimido|comprimidos|unidade|unidades)\b/;

function verificarTraumaGrave(R: RelatoEstruturado, texto: string): DecisaoRegras | null {
  const sinais = R.sinais_trauma || [];

  if (sinais.includes('ferimento_perfurante')) {
    return decisao('trauma_penetrante', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['ferimento por arma']);
  }

  if (sinais.includes('trauma_craniano') &&
      (R.idade_grupo === 'idoso' || R.confusao === true || (R.sinais_neurologicos || []).length > 0)) {
    return decisao('trauma_craniano_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['trauma craniano com sinal']);
  }

  if (sinais.includes('trauma_automobilistico') || sinais.includes('queda_altura') ||
      contemAlgum(texto, ['atropelamento', 'acidente de carro', 'colisao', 'capotamento', 'queda de altura'])) {
    return decisao('trauma_grave_mecanismo', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['mecanismo de trauma grave']);
  }

  // [FIX] Intoxicação grave: por qualificador OU por quantidade
  if (R.exposicao_intoxicacao === true &&
      (contemAlgum(texto, ['grave', 'intenso', 'forte', 'perigo', 'urgente', 'muito']) ||
       QUANTIDADE_INTOX.test(texto))) {
    return decisao('intoxicacao_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['intoxicação grave']);
  }

  if (R.sintomas.includes('queimadura') &&
      contemAlgum(texto, ['extensa', 'grande', 'grave', '2 grau', '3 grau', 'muito'])) {
    return decisao('queimadura_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['queimadura grave']);
  }

  return null;
}

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

  // ════════════ NÍVEL 1 — CRÍTICO (SAMU AGORA) ════════════

  if (R.risco_mental === 'iminente') {
    return decisao('mental_iminente', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'mental_emergencia_001', 'SAMU_AGORA', ['risco de autoagressão']);
  }

  if ((R.sinais_alerta || []).includes('violencia_sexual') ||
      (R.sinais_alerta || []).includes('violencia_domestica')) {
    return decisao('violencia', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'violencia_001', 'SAMU_AGORA', ['situação de violência']);
  }

  const trauma = verificarTraumaGrave(R, texto);
  if (trauma) return trauma;

  if ((R.sinais_neurologicos || []).length > 0) {
    return decisao('avc_suspeito', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['sinais neurológicos súbitos']);
  }

  if (R.alergia_grave === true) {
    return decisao('anafilaxia', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['reação alérgica grave']);
  }

  // [FIX] Convulsão é emergência (antes caía em UBS por falta de regra)
  if ((R.sinais_alerta || []).includes('convulsao')) {
    return decisao('convulsao', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['convulsão']);
  }

  if (R.falta_de_ar === true && (flagFalse(R.fala_frases) || flag(R.labios_roxos))) {
    return decisao('resp_grave', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['falta de ar com critério']);
  }

  if (R.dor_no_peito === true && (R.falta_de_ar === true || R.desmaio === true || R.confusao === true)) {
    return decisao('dor_toracica_com_sinais', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['dor torácica com sinais']);
  }

  if (R.autodiagnostico_grave) {
    return decisao(`autodiag_${R.autodiagnostico_grave}`, 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', [`relato de ${R.autodiagnostico_grave}`]);
  }

  if (R.desmaio === true && R.confusao === true) {
    return decisao('inconsciencia', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['alteração grave de consciência']);
  }

  const temPressao = contemAlgum(texto, ['pressao alta', 'pressao subiu', 'pressao elevada', 'hipertensao']);
  if (temPressao &&
      contemAlgum(texto, ['dor de cabeca', 'cabeca explodindo', 'visao turva', 'visao embacada', 'dor no peito', 'falta de ar', 'vomito'])) {
    return decisao('emergencia_pressao_sintomatica', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['pressão alta com sinal']);
  }

  const obst = verificarEmergenciaObstetrica(R, texto);
  if (obst) return obst;

  if (R.idade_grupo === 'idoso' && R.trauma === true &&
      (R.confusao === true || R.desmaio === true)) {
    return decisao('idoso_queda_confusao', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'emergencia_001', 'SAMU_AGORA', ['idoso com queda e alteração de consciência']);
  }

  for (const regra of (emergencias as RegrasContainer).regras) {
    if (regra.quando.some((p) => contemAlgum(texto, [p]))) {
      return decisao(regra.id, 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
        'emergencia_001', 'SAMU_AGORA', [regra.id]);
    }
  }

  if (R.idade_grupo === 'bebe' && R.febre === true) {
    return decisao('pediatria_bebe_febre', 'emergencia', 'SAMU_192_PRONTO_SOCORRO',
      'pediatria_emergencia_001', 'SAMU_AGORA', ['bebê com febre']);
  }

  // ════════════ NÍVEL 2 — UPA AGORA ════════════

  if ((R.idade_grupo === 'bebe' || R.idade_grupo === 'crianca') && flagFalse(R.consegue_beber)) {
    return decisao('pediatria_desidratacao', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['criança que não bebe']);
  }

  if (R.falta_de_ar === true) {
    return decisao('falta_de_ar_isolada', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['falta de ar']);
  }

  if (R.dor_no_peito === true || R.desmaio === true || R.confusao === true || R.sangramento === true) {
    return decisao('sinal_alarme_isolado', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['sinal de alarme']);
  }

  if ((R.sinais_trauma || []).some((s) => ['trauma_automobilistico', 'queda_altura'].includes(s))) {
    return decisao('trauma_mecanismo', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['trauma com mecanismo de risco']);
  }

  if (R.sintomas.some((s) => /picada de animal peçonhento/.test(s))) {
    return decisao('animal_peconhento', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['picada de animal peçonhento']);
  }

  if (R.sintomas.some((s) => /sintoma urinário/.test(s)) &&
      (R.febre === true || contemAlgum(texto, ['dor nas costas', 'dor lombar', 'dor nos rins']))) {
    return decisao('urinario_com_febre', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['sintoma urinário com alarme']);
  }

  if (R.sintomas.includes('queimadura')) {
    return decisao('queimadura', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['queimadura']);
  }

  if (R.sintomas.includes('suspeita de dengue')) {
    return decisao('dengue', 'urgencia', 'UPA_24H',
      'dengue_001', 'UPA_AGORA', ['suspeita de dengue']);
  }

  if (R.sintomas.includes('sinais de desidratação')) {
    return decisao('desidratacao', 'urgencia', 'UPA_24H',
      'desidratacao_001', 'UPA_AGORA', ['sinais de desidratação']);
  }

  if (R.exposicao_intoxicacao === true) {
    return decisao('intoxicacao', 'urgencia', 'UPA_24H',
      'intoxicacao_001', 'UPA_AGORA', ['exposição a intoxicação']);
  }

  for (const regra of (urgencias as RegrasContainer).regras) {
    if (regra.quando.some((p) => contemAlgum(texto, [p]))) {
      return decisao(regra.id, 'urgencia', 'UPA_24H', 'upa_001', 'UPA_AGORA', [regra.id]);
    }
  }

  if (R.sintomas.length > 0 && (R.intensidade === 'intensa' || R.piora === 'sim')) {
    return decisao('queixa_intensa_ou_piora', 'urgencia', 'UPA_24H',
      'upa_001', 'UPA_AGORA', ['intensidade ou piora']);
  }

  // ════════════ NÍVEL 3 — HOJE ════════════

  const durLonga = duracaoEmDias(R.duracao) >= 3;
  if (R.febre === true && durLonga) {
    return decisao('febre_persistente', 'urgencia', 'UPA_24H',
      'upa_001', 'HOJE', ['febre prolongada']);
  }

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

  // ════════════ NÍVEL 4 — AGENDAR (UBS) ════════════

  if (R.sintomas.includes('dor de dente')) {
    return decisao('odontologia', 'baixa_gravidade', 'UBS_CLINICA_DA_FAMILIA',
      'odontologia_001', 'AGENDAR', ['dor de dente']);
  }

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