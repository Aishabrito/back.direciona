import levenshtein from 'fast-levenshtein';
import faqDados from '../regras/faq_sus.json';
import { normalizarTexto } from './normalizar';

export type ItemFaq = { id: string; gatilhos: string[]; resposta: string };

const STOP_WORDS = new Set([
  'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'nao', 'uma',
  'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'mas', 'ao', 'ele',
  'das', 'qual', 'quando', 'onde', 'pq', 'porque', 'pra', 'qualquer',
]);

function extrairTokens(texto: string): string[] {
  return normalizarTexto(texto)
    .split(/\s+/)
    .filter((palavra) => palavra.length > 2 && !STOP_WORDS.has(palavra));
}

// [FIX 2] removido `includes` bidirecional (fazia "dor" casar com "adorei" etc.)
function palavrasSemelhantes(tokenUsuario: string, tokenGatilho: string): boolean {
  if (tokenUsuario === tokenGatilho) return true;

  // Prefixo significativo (>=5) apenas quando um é prefixo real do outro
  if (tokenUsuario.length >= 5 && tokenGatilho.length >= 5) {
    if (tokenUsuario.startsWith(tokenGatilho) || tokenGatilho.startsWith(tokenUsuario)) {
      return true;
    }
  }

  const distancia = levenshtein.get(tokenUsuario, tokenGatilho);
  const tamanhoMaximo = Math.max(tokenUsuario.length, tokenGatilho.length);

  if (tamanhoMaximo <= 5) return distancia <= 1;
  return distancia <= 2;
}

export function checarFaq(texto: string): ItemFaq | null {
  const tokensUsuario = extrairTokens(texto);
  if (tokensUsuario.length === 0) return null;

  let melhorItem: ItemFaq | null = null;
  let maiorPontuacao = 0;

  for (const item of faqDados.duvidas) {
    for (const gatilho of item.gatilhos) {
      const tokensGatilho = extrairTokens(gatilho);
      if (tokensGatilho.length === 0) continue;

      let acertos = 0;
      for (const tokenU of tokensUsuario) {
        if (tokensGatilho.some((tG) => palavrasSemelhantes(tokenU, tG))) acertos++;
      }

      const pontuacao = acertos / Math.min(tokensUsuario.length, tokensGatilho.length);
      if (pontuacao > maiorPontuacao) {
        maiorPontuacao = pontuacao;
        melhorItem = item;
      }
    }
  }

  return maiorPontuacao >= 0.6 ? melhorItem : null;
}