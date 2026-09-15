"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rotasApi = void 0;
// src/api/rotas.ts
const express_1 = require("express");
const orquestrador_js_1 = require("../ia/orquestrador.js");
exports.rotasApi = (0, express_1.Router)();
// Mapa simples em memória por sessão (para produção, use Redis ou banco)
const sessoesApp = new Map();
exports.rotasApi.post('/chat', async (req, res) => {
    try {
        const { sessionId, mensagem } = req.body;
        if (!sessionId || !mensagem) {
            return res.status(400).json({ erro: 'sessionId e mensagem são obrigatórios.' });
        }
        const estadoAtual = sessoesApp.get(sessionId) || { ...orquestrador_js_1.ESTADO_INICIAL };
        const { resultado, estado: novoEstado } = await (0, orquestrador_js_1.processarTurno)(mensagem, estadoAtual);
        sessoesApp.set(sessionId, novoEstado);
        return res.json(resultado);
    }
    catch (erro) {
        console.error('Erro na API de chat:', erro);
        return res.status(500).json({ erro: 'Erro interno ao processar mensagem.' });
    }
});
