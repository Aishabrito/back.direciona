import mensagens from '../respostas/mensagens_aprovadas.json';
import type { MensagemAprovada } from './tipos.js';
import { contemAlgum, normalizarTexto } from './normalizar.js';

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

// Mantido para compatibilidade. Não é mais chamado em templates aprovados.
export function sanitizarResposta(texto: string, _idMensagem?: string): string {
  return texto;
}

// ────────────────────────────────────────────────────────────
// [FIX Bloco 1] Antes o filtro era uma lista solta de substrings — qualquer
// coisa que contivesse "o que eu tenho" (inclusive "o que eu tenho que fazer?")
// era bloqueada. Agora exige contexto de pergunta direta sobre si mesmo.
// ────────────────────────────────────────────────────────────
export function ehPedidoDiagnostico(texto: string): boolean {
  const n = ` ${normalizarTexto(texto)} `;
  // Pergunta direta sobre o diagnóstico
  return (
    /\bqual (e|eh) o (meu )?diagnostico\b/.test(n) ||
    /\bque doenca (eu )?(tenho|possuo)\b/.test(n) ||
    /\bqual (a )?doenca (eu )?(tenho|possuo)\b/.test(n) ||
    /\bme da o diagnostico\b/.test(n) ||
    /\bo que (eu )?tenho\b(?!.*\b(que fazer|que tomar)\b)/.test(n)
  );
}

export function ehPedidoMedicamento(texto: string): boolean {
  const n = ` ${normalizarTexto(texto)} `;

  // Precisa ter (a) verbo direto pedindo indicação E (b) menção a medicamento
  const pedidoDireto =
    /\bme (passa|indica|receita|da|receite)\b/.test(n) ||
    /\bposso tomar\b/.test(n) ||
    /\bo que (eu )?(tomo|posso tomar)\b/.test(n) ||
    /\bqual (remedio|medicamento|dose|antiinflamatorio)\b/.test(n) ||
    /\bquanto (eu )?tomo\b/.test(n) ||
    /\bquantas gotas\b/.test(n) ||
    /\bpreciso de (uma )?receita\b/.test(n);

  const nomeDeRemedio =
    /\b(dipirona|paracetamol|ibuprofeno|aspirina|aas|antibiotico|antiinflamatorio|remedio|medicamento|comprimido|dose)\b/.test(n);

  // "posso tomar banho?" — pedidoDireto casa, mas não tem nomeDeRemedio.
  // "tomei antibiotico ontem" — nomeDeRemedio casa, mas não tem pedidoDireto.
  return pedidoDireto && nomeDeRemedio;
}