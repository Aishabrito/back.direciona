// src/api/rotas.ts
import { Router } from 'express';
import { processarTurno, ESTADO_INICIAL } from '../ia/orquestrador.js';
import type { EstadoConversa } from '../ia/tipos.js';

export const rotasApi = Router();

type SessaoArmazenada = { estado: EstadoConversa; atualizadoEm: number };
const sessoesApp = new Map<string, SessaoArmazenada>();
const TTL_MS = 30 * 60 * 1000;

const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [id, s] of sessoesApp) {
    if (agora - s.atualizadoEm > TTL_MS) sessoesApp.delete(id);
  }
}, 5 * 60 * 1000);
limpeza.unref?.();

rotasApi.post('/chat', async (req, res) => {
  try {
    const { sessionId, mensagem } = req.body;

    if (!sessionId || !mensagem) {
      return res.status(400).json({ erro: 'sessionId e mensagem são obrigatórios.' });
    }

    const salva = sessoesApp.get(sessionId);
    const estadoAtual = salva?.estado || { ...ESTADO_INICIAL };
    const { resultado, estado: novoEstado } = await processarTurno(mensagem, estadoAtual);

    sessoesApp.set(sessionId, { estado: novoEstado, atualizadoEm: Date.now() });

    return res.json(resultado);
  } catch (erro) {
    console.error('Erro na API de chat:', erro);
    return res.status(500).json({ erro: 'Erro interno ao processar mensagem.' });
  }
});