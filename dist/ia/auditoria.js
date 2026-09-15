"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registrarDecisao = registrarDecisao;
exports.ultimosEventos = ultimosEventos;
const eventos = [];
function registrarDecisao(decisao) {
    const evento = {
        em: new Date().toISOString(),
        regra_acionada: decisao.regra_acionada,
        categoria_interna: decisao.categoria_interna,
        destino: decisao.destino,
        resposta_id: decisao.resposta_id,
        versao_regras: decisao.versao_regras,
    };
    eventos.push(evento);
    if (eventos.length > 50)
        eventos.shift();
    return evento;
}
function ultimosEventos() {
    return [...eventos];
}
