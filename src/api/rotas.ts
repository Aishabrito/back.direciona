// API usada pelo app mobile (direciona-sus): o mesmo bot do WhatsApp, por HTTP.
import { Router } from 'express';
import { processarTurno, ESTADO_INICIAL } from '../ia/orquestrador.js';
import type { EstadoConversa } from '../ia/tipos.js';
import { metricas } from '../servicos/metricas.js';
import { buscarUnidades, formatarUnidades, type TipoUsuario } from '../servicos/geolocalizacao.js';
import { buscarCoordenadasPorTexto } from '../servicos/nominatim.js';
import { tipoParaOferecer, artigoUnidade } from '../servicos/oferta_localizacao.js';

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

    // Mesma oferta do WhatsApp ("quer saber a UPA mais próxima?"); o app mostra o botão.
    const tipo = tipoParaOferecer(resultado);
    const local = tipo ? { tipo, rotulo: rotuloUnidade(tipo) } : undefined;

    return res.json({ ...resultado, local });
  } catch (erro) {
    console.error('Erro na API de chat:', erro);
    return res.status(500).json({ erro: 'Erro interno ao processar mensagem.' });
  }
});

const TIPOS_VALIDOS: TipoUsuario[] = ['UPA', 'HOSPITAL', 'UBS'];

function rotuloUnidade(tipo: TipoUsuario): string {
  const { art, prox, nome } = artigoUnidade(tipo);
  return `${art} ${nome} mais ${prox}`;
}

// Unidades mais próximas, pela localização do celular ({ lat, lng }) ou pelo
// bairro e cidade digitados ({ endereco }). Devolve o mesmo texto do WhatsApp.
rotasApi.post('/unidades', async (req, res) => {
  try {
    const { tipo, lat, lng, endereco } = req.body ?? {};
    if (!TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ erro: 'tipo deve ser UPA, HOSPITAL ou UBS.' });
    }

    let coords: { lat: number; lng: number } | null = null;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      coords = { lat, lng };
    } else if (typeof endereco === 'string' && endereco.trim()) {
      if (endereco.length > 200) return res.status(413).json({ erro: 'Endereço muito longo.' });
      coords = await buscarCoordenadasPorTexto(endereco);
      if (!coords) {
        return res.status(404).json({
          erro: 'endereco_nao_encontrado',
          texto: 'Não consegui localizar esse endereço. Tente *bairro e cidade* (ex: "Icaraí, Niterói") ou use a sua localização.',
        });
      }
    } else {
      return res.status(400).json({ erro: 'Envie lat e lng, ou endereco.' });
    }

    const r = await buscarUnidades(coords.lat, coords.lng, tipo);
    return res.json({
      texto: formatarUnidades(r.unidades, coords.lat, coords.lng, tipo, { falhaServico: r.falhaServico }),
      quantidade: r.unidades.length,
    });
  } catch (erro) {
    console.error('Erro na API de unidades:', erro);
    return res.status(500).json({
      erro: 'Erro interno ao buscar unidades.',
      texto: '❌ Erro ao buscar unidades próximas. Se for emergência, ligue *192* agora.',
    });
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
