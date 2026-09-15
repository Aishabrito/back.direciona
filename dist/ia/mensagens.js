"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mensagemPorId = mensagemPorId;
exports.sanitizarResposta = sanitizarResposta;
exports.ehPedidoDiagnostico = ehPedidoDiagnostico;
exports.ehPedidoMedicamento = ehPedidoMedicamento;
const mensagens_aprovadas_json_1 = __importDefault(require("../respostas/mensagens_aprovadas.json"));
const normalizar_js_1 = require("./normalizar.js");
const TERMOS_PROIBIDOS = [
    'infarto',
    'avc',
    'derrame',
    'manchester',
    'vermelho',
    'laranja',
    'amarelo',
    'classificacao',
    'classificação',
    'tempo de espera',
    'comprimido',
    'antibiotico',
    'antibiótico',
    'tratamento com',
    'vaga',
];
function mensagemPorId(id) {
    const encontrada = mensagens_aprovadas_json_1.default.mensagens.find((item) => item.id === id);
    const fallback = mensagens_aprovadas_json_1.default.mensagens.find((item) => item.id === 'fallback_001');
    if (!encontrada)
        return fallback;
    return encontrada;
}
function sanitizarResposta(texto, idMensagem) {
    if (idMensagem === 'recusa_medicamento' || idMensagem === 'recusa_diagnostico') {
        return texto;
    }
    const n = (0, normalizar_js_1.normalizarTexto)(texto);
    if (TERMOS_PROIBIDOS.some((termo) => n.includes((0, normalizar_js_1.normalizarTexto)(termo)))) {
        return mensagemPorId('fallback_001').texto;
    }
    return texto;
}
function ehPedidoDiagnostico(texto) {
    return (0, normalizar_js_1.contemAlgum)(texto, [
        'qual e o diagnostico',
        'qual o meu diagnostico',
        'que doenca eu tenho',
        'isso e infarto',
        'estou com infarto',
        'isso e avc',
        'sera que e avc',
        'sera que e dengue',
        'sera que e covid',
        'o que eu tenho',
        'qual doenca',
    ]);
}
function ehPedidoMedicamento(texto) {
    return (0, normalizar_js_1.contemAlgum)(texto, [
        'posso tomar',
        'o que tomar',
        'qual remedio',
        'qual medicamento',
        'quantas gotas',
        'receita de',
        'qual dose',
        'antibiotico',
        'passa um remedio',
        'qual antiinflamatorio',
    ]);
}
