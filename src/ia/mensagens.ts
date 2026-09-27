import mensagens from '../respostas/mensagens_aprovadas.json';
import type { MensagemAprovada } from './tipos.js';
import { normalizarTexto } from './normalizar.js';

// Blocklist enxuta. Termos como "infarto"/"avc"/"derrame" podem aparecer
// em mensagens de emergência (aprovadas). "vaga" saiu porque casava com "devagar".
const TERMOS_PROIBIDOS = [
  'manchester',
  'classificacao de risco',
  'tempo de espera',
];

export function mensagemPorId(id: string): MensagemAprovada {
  const encontrada = mensagens.mensagens.find((item) => item.id === id);
  const fallback = mensagens.mensagens.find((item) => item.id === 'fallback_001');
  if (!encontrada) return fallback as MensagemAprovada;
  return encontrada as MensagemAprovada;
}

// Só sanitiza texto gerado dinamicamente (LLM). Templates aprovados passam direto.
export function sanitizarTextoGerado(texto: string): string {
  const n = normalizarTexto(texto);
  if (TERMOS_PROIBIDOS.some((termo) => n.includes(normalizarTexto(termo)))) {
    return mensagemPorId('fallback_001').texto;
  }
  return texto;
}
