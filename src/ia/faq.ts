
import levenshtein from 'fast-levenshtein';
import faqDados from '../regras/faq_sus.json';
import { normalizarTexto } from './normalizar';

export type ItemFaq = {
  id: string;
  gatilhos: string[];
  resposta: string;
};

const STOP_WORDS = new Set([
  'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'nao', 'uma',
  'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'mas', 'ao', 'ele',
  'das', 'qual', 'quando', 'onde', 'pq', 'porque', 'por que', 'pra', 'qualquer'
]);

function extrairTokens(texto: string): string[] {
  return normalizarTexto(texto)
    .split(/\s+/)
    .filter((palavra) => palavra.length > 2 && !STOP_WORDS.has(palavra));
}

// Retorna true se as palavras forem idênticas ou com tolerância de digitação
function palavrasSemelhantes(tokenUsuario: string, tokenGatilho: string): boolean {
  if (tokenUsuario === tokenGatilho) return true;
  if (tokenGatilho.includes(tokenUsuario) || tokenUsuario.includes(tokenGatilho)) return true;

  const distancia = levenshtein.get(tokenUsuario, tokenGatilho);
  const tamanhoMaximo = Math.max(tokenUsuario.length, tokenGatilho.length);

  // Palavras curtas (3 a 5 letras): aceita até 1 caractere errado
  if (tamanhoMaximo <= 5) {
    return distancia <= 1;
  }
  // Palavras médias/longas (6+ letras): aceita até 2 caracteres errados
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
        if (tokensGatilho.some((tG) => palavrasSemelhantes(tokenU, tG))) {
          acertos++;
        }
      }

      const pontuacao = acertos / Math.min(tokensUsuario.length, tokensGatilho.length);

      if (pontuacao > maiorPontuacao) {
        maiorPontuacao = pontuacao;
        melhorItem = item;
      }
    }
  }

  // Limiar de confiança de 60%
  if (maiorPontuacao >= 0.6) {
    return melhorItem;
  }

  return null;
}