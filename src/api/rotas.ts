// src/api/rotas.ts
import { Router } from 'express';
import { processarTurno, ESTADO_INICIAL } from '../ia/orquestrador.js';
import type { EstadoConversa } from '../ia/tipos.js';

export const rotasApi = Router();

// Mapa simples em memória por sessão (para produção, use Redis ou banco)
const sessoesApp = new Map<string, EstadoConversa>();

rotasApi.post('/chat', async (req, res) => {
  try {
    const { sessionId, mensagem } = req.body;

    if (!sessionId || !mensagem) {
      return res.status(400).json({ erro: 'sessionId e mensagem são obrigatórios.' });
    }

    const estadoAtual = sessoesApp.get(sessionId) || { ...ESTADO_INICIAL };
    const { resultado, estado: novoEstado } = await processarTurno(mensagem, estadoAtual);

    sessoesApp.set(sessionId, novoEstado);

    return res.json(resultado);
  } catch (erro) {
    console.error('Erro na API de chat:', erro);
    return res.status(500).json({ erro: 'Erro interno ao processar mensagem.' });
  }
});