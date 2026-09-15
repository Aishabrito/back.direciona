"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELATO_VAZIO = exports.DESTINOS = exports.CATEGORIAS_INTERNAS = exports.RISCOS_MENTAIS = exports.VALORES_SIM_NAO = exports.IDADE_GRUPOS = exports.VERSAO_REGRAS = void 0;
// ia/tipos.ts
exports.VERSAO_REGRAS = '1.0.0';
exports.IDADE_GRUPOS = [
    'bebe',
    'crianca',
    'adolescente',
    'adulto',
    'idoso',
    'nao_informado',
];
exports.VALORES_SIM_NAO = ['sim', 'nao', 'nao_informado'];
exports.RISCOS_MENTAIS = [
    'iminente',
    'sem_risco_imediato',
    'nao_mencionado',
];
exports.CATEGORIAS_INTERNAS = [
    'emergencia',
    'urgencia',
    'baixa_gravidade',
    'saude_mental_sem_risco_imediato',
    'situacao_obstetrica',
    'informacao_insuficiente',
    'fora_do_escopo',
];
exports.DESTINOS = [
    'SAMU_192',
    'PRONTO_SOCORRO',
    'SAMU_192_PRONTO_SOCORRO',
    'UPA_24H',
    'UBS_CLINICA_DA_FAMILIA',
    'MATERNIDADE_PRONTO_SOCORRO_OBSTETRICO',
    'CAPS_OU_SERVICO_DE_SAUDE_MENTAL',
    'FALLBACK',
];
exports.RELATO_VAZIO = {
    relato_sobre_terceiro: false,
    pessoa: 'nao_informado',
    idade_grupo: 'nao_informado',
    sintomas: [],
    sinais_alerta: [],
    inicio: 'nao_informado',
    duracao: 'nao_informado',
    piora: 'nao_informado',
    intensidade: 'nao_informado',
    falta_de_ar: 'nao_informado',
    dor_no_peito: 'nao_informado',
    desmaio: 'nao_informado',
    confusao: 'nao_informado',
    sangramento: 'nao_informado',
    febre: 'nao_informado',
    vomitos: 'nao_informado',
    trauma: 'nao_informado',
    exposicao_intoxicacao: 'nao_informado',
    gestante: 'nao_informado',
    pos_parto: 'nao_informado',
    risco_mental: 'nao_mencionado',
    informacao_insuficiente: true,
    informacoes_contraditorias: [],
    sinais_obstetricos: [],
    sinais_trauma: [],
    texto_original_acumulado: '',
};
