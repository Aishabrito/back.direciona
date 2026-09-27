// src/ia/rate_limit.ts
// Limitador global de chamadas ao Groq. Não é por usuário — é total.
// Protege contra estouro de quota em picos.

const JANELA_MS = 60_000;
const LIMITE_POR_JANELA = 25;

let contador = 0;
let inicioJanela = Date.now();

export function podeChamarGroq(): boolean {
  const agora = Date.now();
  if (agora - inicioJanela > JANELA_MS) {
    contador = 0;
    inicioJanela = agora;
  }
  if (contador >= LIMITE_POR_JANELA) return false;
  contador++;
  return true;
}

export function statusRateLimit(): { usado: number; limite: number; janelaRestanteMs: number } {
  const agora = Date.now();
  const restante = Math.max(0, JANELA_MS - (agora - inicioJanela));
  return { usado: contador, limite: LIMITE_POR_JANELA, janelaRestanteMs: restante };
}