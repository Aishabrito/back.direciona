
import { Router } from 'express';
import { processarTurno, ESTADO_INICIAL } from '../ia/orquestrador.js';
import type { EstadoConversa } from '../ia/tipos.js';
import { metricas } from '../servicos/metricas.js';

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

    if (typeof sessionId !== 'string' || typeof mensagem !== 'string' || !sessionId || !mensagem.trim()) {
      return res.status(400).json({ erro: 'sessionId e mensagem são obrigatórios.' });
    }
    if (mensagem.length > 2000) {
      return res.status(413).json({ erro: 'Mensagem muito longa (máx. 2000 caracteres).' });
    }

    const salva = sessoesApp.get(sessionId);
    const estadoAtual = salva?.estado || JSON.parse(JSON.stringify(ESTADO_INICIAL));
    const { resultado, estado: novoEstado } = await processarTurno(mensagem, estadoAtual, { origem: 'api' });

    sessoesApp.set(sessionId, { estado: novoEstado, atualizadoEm: Date.now() });

    return res.json(resultado);
  } catch (erro) {
    console.error('Erro na API de chat:', erro);
    return res.status(500).json({ erro: 'Erro interno ao processar mensagem.' });
  }
});

// Métricas de qualidade — só com METRICAS_TOKEN configurado (senão fica desligado).
rotasApi.get('/metricas', (req, res) => {
  const token = req.headers['x-metricas-token'];
  const tokenEsperado = process.env.METRICAS_TOKEN;
  if (!tokenEsperado) return res.status(404).json({ erro: 'Métricas desativadas.' });
  if (token !== tokenEsperado) {
    return res.status(401).json({ erro: 'Token inválido.' });
  }
  return res.json(metricas);
});