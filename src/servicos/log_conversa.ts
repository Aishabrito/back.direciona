// src/servicos/log_conversa.ts
// Log estruturado por turno. Saída em JSON — filtra fácil no Render por "📊 [LOG]".

export type LogTurno = {
  ts: string;
  sessao?: string;
  texto_usuario: string;
  tamanho_historico: number;
  intent?: string;
  regra_acionada?: string;
  nivel?: string;
  destino?: string;
  resposta_id?: string;
  bloqueado?: boolean;
  fase_anterior: string;
  fase_nova: string;
  latencia_ms: number;
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