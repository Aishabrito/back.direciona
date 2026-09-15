"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizarTexto = normalizarTexto;
exports.contemAlgum = contemAlgum;
exports.unicos = unicos;
function normalizarTexto(texto) {
    return texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function contemAlgum(texto, termos) {
    const n = normalizarTexto(texto);
    return termos.some((termo) => n.includes(normalizarTexto(termo)));
}
function unicos(valores) {
    const vistos = new Set();
    const saida = [];
    for (const valor of valores) {
        const chave = normalizarTexto(valor);
        if (!chave || vistos.has(chave))
            continue;
        vistos.add(chave);
        saida.push(valor);
    }
    return saida;
}
