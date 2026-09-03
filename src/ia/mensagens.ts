import mensagens from '../respostas/mensagens_aprovadas.json';
import type { MensagemAprovada } from './tipos.js';
import { contemAlgum, normalizarTexto } from './normalizar.js';

const TERMOS_PROIBIDOS = [
  'infarto',
  'avc',
  'derrame',
  'manchester',
  'vermelho',
  'laranja',
  'amarelo',
  'classificacao',
  'classificação',
  'tempo de espera',
  'comprimido',
  'antibiotico',
  'antibiótico',
  'tratamento com',
  'vaga',
];

export function mensagemPorId(id: string): MensagemAprovada {
  const encontrada = mensagens.mensagens.find((item) => item.id === id);
  const fallback = mensagens.mensagens.find((item) => item.id === 'fallback_001');
  if (!encontrada) return fallback as MensagemAprovada;
  return encontrada as MensagemAprovada;
}

export function sanitizarResposta(texto: string, idMensagem?: string): string {
  if (idMensagem === 'recusa_medicamento' || idMensagem === 'recusa_diagnostico') {
    return texto;
  }

  const n = normalizarTexto(texto);
  if (TERMOS_PROIBIDOS.some((termo) => n.includes(normalizarTexto(termo)))) {
    return mensagemPorId('fallback_001').texto;
  }
  return texto;
}

export function ehPedidoDiagnostico(texto: string): boolean {
  return contemAlgum(texto, [
    'qual e o diagnostico',
    'qual o meu diagnostico',
    'que doenca eu tenho',
    'isso e infarto',
    'estou com infarto',
    'isso e avc',
    'sera que e avc',
    'sera que e dengue',
    'sera que e covid',
    'o que eu tenho',
    'qual doenca',
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