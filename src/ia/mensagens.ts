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

───────────────────────────────────────────────────────────
export function ehPedidoDiagnostico(texto: string): boolean {
  const n = normalizarTexto(texto);
  return /\b(o que (eu )?tenho|oq (eu )?tenho|qual (a )?(minha )?doenca|qual (o )?(meu )?problema|me diagnostica|me da um diagnostico|pode ser (o )?que|sera (o )?que (eu )?tenho|isso (e|eh) (o )?que|meus sintomas (sao|são|e|eh)|meus? sintomas? (podem|pode) ser|isso (pode|pode ser) (ser )?|tenho (isso|aquilo|o que))\b/.test(n);
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