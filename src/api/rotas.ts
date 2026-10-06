// API usada pelo app mobile (direciona-sus). É o MESMO atendimento do WhatsApp
// (atendimento/atendimento.ts): comandos, boas-vindas, áudio, localização e triagem.
import { Router } from 'express';
import type { EstadoConversa } from '../ia/tipos.js';
import { metricas } from '../servicos/metricas.js';
import { textoParaAudio } from '../servicos/texto_para_audio.js';
import { inc } from '../servicos/metricas.js';
import {
  atenderTexto, atenderAudio, atenderLocalizacao, MENSAGEM_BOAS_VINDAS, type Canal,
} from '../atendimento/atendimento.js';

export const rotasApi = Router();

// Estado das conversas do app em memória (o do WhatsApp fica no banco).
// Expira depois de 30 min sem mensagem.
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

// Mensagens que o app recebe: texto e, para quem mandou áudio, a resposta falada (MP3).
type MensagemApp = { texto: string; audio?: { base64: string; mime: 'audio/mpeg' } };

// Uma conversa do app por vez (como a fila por número do WhatsApp).
const filas = new Map<string, Promise<unknown>>();
function naFila<T>(sessionId: string, tarefa: () => Promise<T>): Promise<T> {
  const atual = (filas.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(tarefa);
  filas.set(sessionId, atual);
  atual.finally(() => { if (filas.get(sessionId) === atual) filas.delete(sessionId); }).catch(() => {});
  return atual;
}

function canalApp(sessionId: string, saida: MensagemApp[], pendentes: Promise<void>[]): Canal {
  return {
    sessaoLog: `app-${sessionId.slice(-8)}`,
    carregar: async () => sessoesApp.get(sessionId)?.estado ?? null,
    salvar: async (estado) => { sessoesApp.set(sessionId, { estado, atualizadoEm: Date.now() }); },
    apagar: async () => { sessoesApp.delete(sessionId); },
    enviar: async ({ texto, fala }) => {
      const msg: MensagemApp = { texto };
      saida.push(msg);
      if (!fala) return;
      // Gera o áudio em paralelo; a resposta HTTP espera por ele no fim.
      pendentes.push(
        textoParaAudio(fala, 'feminina', 'mp3').then((audio) => {
          if (audio && audio.length > 0) {
            inc('gemini_tts_ok');
            msg.audio = { base64: audio.toString('base64'), mime: 'audio/mpeg' };
          } else {
            inc('gemini_tts_erro');
          }
        }),
      );
    },
    local: 'botão 📍',
    localDestaque: 'botão *📍*',
    // O app mostra a apresentação ao abrir o chat (GET /api/boas-vindas).
    boasVindasNaPrimeira: false,
  };
}

/** Roda o atendimento e monta a resposta para o app. */
async function atender(sessionId: string, acao: (canal: Canal) => Promise<void>) {
  return naFila(sessionId, async () => {
    const saida: MensagemApp[] = [];
    const pendentes: Promise<void>[] = [];
    await acao(canalApp(sessionId, saida, pendentes));
    await Promise.all(pendentes);
    const estado = sessoesApp.get(sessionId)?.estado;
    const texto = saida.map((m) => m.texto).join('\n\n');
    return {
      mensagens: saida,
      // Para o app mostrar o botão "Enviar minha localização".
      aguardandoLocalizacao: Boolean(estado?.aguardandoLocalizacao?.ativo),
      // Compatibilidade com a versão anterior do app (só texto).
      tipo: estado?.fase === 'orientado' ? 'orientacao' : 'perguntas',
      texto,
    };
  });
}

function sessaoValida(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 100;
}

// Texto digitado (inclusive comandos: "início", "apagar", "sim", bairro e cidade...).
rotasApi.post('/chat', async (req, res) => {
  try {
    const { sessionId, mensagem } = req.body ?? {};
    if (!sessaoValida(sessionId) || typeof mensagem !== 'string' || !mensagem.trim()) {
      return res.status(400).json({ erro: 'sessionId e mensagem são obrigatórios.' });
    }
    if (mensagem.length > 2000) {
      return res.status(413).json({ erro: 'Mensagem muito longa (máx. 2000 caracteres).' });
    }
    return res.json(await atender(sessionId, (canal) => atenderTexto(canal, mensagem.trim())));
  } catch (erro) {
    console.error('Erro na API de chat:', erro);
    return res.status(500).json({ erro: 'Erro interno ao processar mensagem.' });
  }
});

// Áudio gravado no app: { sessionId, audio (base64), mime }. Transcrito como no WhatsApp,
// e a resposta volta também em áudio (MP3).
rotasApi.post('/audio', async (req, res) => {
  try {
    const { sessionId, audio, mime } = req.body ?? {};
    if (!sessaoValida(sessionId) || typeof audio !== 'string' || !audio) {
      return res.status(400).json({ erro: 'sessionId e audio (base64) são obrigatórios.' });
    }
    const buffer = Buffer.from(audio, 'base64');
    const tipoMime = typeof mime === 'string' && mime ? mime : 'audio/mp4';
    return res.json(await atender(sessionId, (canal) => atenderAudio(canal, async () => ({ buffer, mime: tipoMime }))));
  } catch (erro) {
    console.error('Erro na API de áudio:', erro);
    return res.status(500).json({ erro: 'Erro interno ao processar áudio.' });
  }
});

// Localização do celular (equivale ao pino 📎 → Localização do WhatsApp).
rotasApi.post('/localizacao', async (req, res) => {
  try {
    const { sessionId, lat, lng } = req.body ?? {};
    if (!sessaoValida(sessionId) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ erro: 'sessionId, lat e lng são obrigatórios.' });
    }
    return res.json(await atender(sessionId, (canal) => atenderLocalizacao(canal, lat, lng)));
  } catch (erro) {
    console.error('Erro na API de localização:', erro);
    return res.status(500).json({ erro: 'Erro interno ao processar localização.' });
  }
});

// Apresentação que o WhatsApp manda na 1ª mensagem; o app mostra ao abrir o chat.
rotasApi.get('/boas-vindas', (_req, res) => {
  res.json({ texto: MENSAGEM_BOAS_VINDAS });
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
