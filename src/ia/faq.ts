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
    .filter((p) => p.length > 2 && !STOP_WORDS.has(p));
}

function palavrasSemelhantes(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return true;
  const d = levenshtein.get(a, b);
  const max = Math.max(a.length, b.length);
  return max <= 5 ? d <= 1 : d <= 2;
}

const SINTOMA_PRIMEIRA_PESSOA =
  /\b(estou|to|tenho|sinto|senti|meu|minha|estamos|dor|febre|tosse|falta de ar|sangramento|vomito|vomitei|desmaiei|ca[ií]|bati|bateu)\b/;

export function checarFaq(texto: string): ItemFaq | null {
  const n = normalizarTexto(texto);
  if (SINTOMA_PRIMEIRA_PESSOA.test(n)) return null;

  const tokensUsuario = extrairTokens(texto);
  if (tokensUsuario.length === 0) return null;

  let melhorItem: ItemFaq | null = null;
  let melhorScore = 0;

  for (const item of faqDados.duvidas) {
    for (const gatilho of item.gatilhos) {
      const tokensGatilho = extrairTokens(gatilho);
      if (tokensGatilho.length === 0) continue;

      let acertos = 0;
      for (const tU of tokensUsuario) {
        if (tokensGatilho.some((tG) => palavrasSemelhantes(tU, tG))) acertos++;
      }

      const cobertura = acertos / tokensGatilho.length;
      const score = cobertura * acertos;

      if (cobertura >= 0.75 && acertos >= 2 && score > melhorScore) {
        melhorScore = score;
        melhorItem = item;
      }
    }
  }
  return melhorItem;
}