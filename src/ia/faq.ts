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

// [FIX] Mais permissivo: aceita erro de digitação, transposição, plural
function palavrasSemelhantes(a: string, b: string): boolean {
  if (a === b) return true;

  // Prefixo de pelo menos 4 caracteres
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 4) {
    let comum = 0;
    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) comum++;
      else break;
    }
    if (comum >= minLen - 1) return true;
  }

  // Um contém o outro (>= 4 chars) — pega plural, diminutivo, prefixo comum
  if (minLen >= 4 && (a.includes(b) || b.includes(a))) return true;

  const d = levenshtein.get(a, b);
  const max = Math.max(a.length, b.length);
  if (max <= 4) return d <= 1;
  if (max <= 7) return d <= 2;
  return d <= 3;
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

      // Perguntas curtas (1-2 tokens) toleram 1 acerto com cobertura alta
      const minAcertos = tokensUsuario.length <= 2 ? 1 : 2;
      const coberturaMin = tokensUsuario.length <= 2 ? 0.7 : 0.75;
      if (cobertura >= coberturaMin && acertos >= minAcertos && score > melhorScore) {
        melhorScore = score;
        melhorItem = item;
      }
    }
  }
  return melhorItem;
}