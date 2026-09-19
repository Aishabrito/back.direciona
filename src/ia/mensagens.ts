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

export function ehPedidoDiagnostico(texto: string): boolean {
  return contemAlgum(texto, [
    'qual e o diagnostico',
    'qual o meu diagnostico',
    'que doenca eu tenho',
    'o que eu tenho',
    'qual doenca',
    'me da o diagnostico',
  ]);
}

export function ehPedidoMedicamento(texto: string): boolean {
  return contemAlgum(texto, [
    'posso tomar',
    'o que tomar',
    'qual remedio',
    'qual medicamento',
    'quantas gotas',
    'receita de',
    'qual dose',
    'antibiotico',
    'passa um remedio',
    'qual antiinflamatorio',
  ]);
}