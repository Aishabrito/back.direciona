// src/servicos/log_conversa.ts
// Log estruturado por turno. Saída em JSON — filtra fácil no Render por "📊 [LOG]".
// Base da revisão semanal: amostrar conversas, anotar erros, ajustar o PROMPT (não regex).

export type LogTurno = {
  ts: string;
  sessao?: string;
  origem_msg: 'texto' | 'audio' | 'api';
  msg: string;
  acao: string;
  destino: string;
  origem_decisao: string;
  foi_guarda_regex: boolean;
  motivo_interno?: string;
  latencia_ms: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
  validacao_alterou: boolean;
  validacao_motivos?: string[];
  reformulou: boolean;
  falhas_seguidas: number;
  escalado: boolean;
  fase_anterior: string;
  fase_nova: string;
  erro?: string;
};

export function logTurno(dados: LogTurno): void {
  try {
    console.log(`📊 [LOG] ${JSON.stringify(dados)}`);
  } catch (err) {
    console.error('❌ [LOG] falha ao serializar:', err);
  }
}

export function iniciarTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}
