"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checarFaq = checarFaq;
const fast_levenshtein_1 = __importDefault(require("fast-levenshtein"));
const faq_sus_json_1 = __importDefault(require("../regras/faq_sus.json"));
const normalizar_1 = require("./normalizar");
const STOP_WORDS = new Set([
    'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'nao', 'uma',
    'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'mas', 'ao', 'ele',
    'das', 'qual', 'quando', 'onde', 'pq', 'porque', 'por que', 'pra', 'qualquer'
]);
function extrairTokens(texto) {
    return (0, normalizar_1.normalizarTexto)(texto)
        .split(/\s+/)
        .filter((palavra) => palavra.length > 2 && !STOP_WORDS.has(palavra));
}
// Retorna true se as palavras forem idênticas ou com tolerância de digitação
function palavrasSemelhantes(tokenUsuario, tokenGatilho) {
    if (tokenUsuario === tokenGatilho)
        return true;
    if (tokenGatilho.includes(tokenUsuario) || tokenUsuario.includes(tokenGatilho))
        return true;
    const distancia = fast_levenshtein_1.default.get(tokenUsuario, tokenGatilho);
    const tamanhoMaximo = Math.max(tokenUsuario.length, tokenGatilho.length);
    // Palavras curtas (3 a 5 letras): aceita até 1 caractere errado
    if (tamanhoMaximo <= 5) {
        return distancia <= 1;
    }
    // Palavras médias/longas (6+ letras): aceita até 2 caracteres errados
    return distancia <= 2;
}
function checarFaq(texto) {
    const tokensUsuario = extrairTokens(texto);
    if (tokensUsuario.length === 0)
        return null;
    let melhorItem = null;
    let maiorPontuacao = 0;
    for (const item of faq_sus_json_1.default.duvidas) {
        for (const gatilho of item.gatilhos) {
            const tokensGatilho = extrairTokens(gatilho);
            if (tokensGatilho.length === 0)
                continue;
            let acertos = 0;
            for (const tokenU of tokensUsuario) {
                if (tokensGatilho.some((tG) => palavrasSemelhantes(tokenU, tG))) {
                    acertos++;
                }
            }
            const pontuacao = acertos / Math.min(tokensUsuario.length, tokensGatilho.length);
            if (pontuacao > maiorPontuacao) {
                maiorPontuacao = pontuacao;
                melhorItem = item;
            }
        }
    }
    // Limiar de confiança de 60%
    if (maiorPontuacao >= 0.6) {
        return melhorItem;
    }
    return null;
}
