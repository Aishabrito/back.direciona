// src/ia/acidente.ts
// Acidente de trânsito/queda: distingue o que acabou de acontecer (ou tem sinal grave)
// do que já passou sem sinal de alarme. Usado pela guarda, pelo piso da validação e pelo motor.
//
//   agora OU sinal grave        → SAMU 192 (+ Bombeiros 193 se preso/fogo)
//   recente (dias) sem gravidade → no mínimo UPA hoje (lesão interna pode aparecer depois)
//   antigo (semanas) sem gravidade → decisão livre (LLM/motor)

import { normalizarTexto } from './normalizar.js';

const ACIDENTE =
  /\b(acidente|batida|bati|bateu|capot\w*|colis\w*|colidiu|atropel\w*|caiu|cai|queda|derrap\w*)\b[^.!?]{0,40}\b(moto|carro|onibus|caminhao|bicicleta|bike|transito|van|patinete)\b|\b(moto|carro|bicicleta|bike)\b[^.!?]{0,25}\b(acidente|bateu|capotou|caiu|derrapou)\b|\batropel\w*|\bcapot\w*/;

const PASSADO =
  /\b(ontem|anteontem|outro dia|dias atras|ha \d+ dias|faz \d+ dias|ha (dois|duas|tres|uns|alguns) dias|semana passada|semanas atras|ha \d+ semanas|faz \d+ semanas|mes passado|meses atras)\b/;

const ANTIGO = /\b(semana passada|semanas atras|ha \d+ semanas|faz \d+ semanas|mes passado|meses atras)\b/;

const SINAL_GRAVE =
  /\b(desmai\w*|inconsciente|desacordad\w*|apag\w*|nao (consegue|consigo|conseguiu) (mexer|levantar|andar|respirar|sentir)|nao sente (as )?pernas|preso|ferragens|fogo|sangrando muito|muito sangue|hemorragia|fratura|osso|confus\w*|sonolen\w*|vomit\w*|falta de ar|dor no peito|barriga (dura|inchada)|dormen\w*|formigamento|nao mexe)\b/;

export function ehAcidenteDeTransito(texto: string): boolean {
  return ACIDENTE.test(normalizarTexto(texto));
}

/** Acidente que já passou (ontem, dias atrás...) e sem nenhum sinal grave no relato. */
export function acidentePassadoSemGravidade(texto: string): boolean {
  const n = normalizarTexto(texto);
  return PASSADO.test(n) && !SINAL_GRAVE.test(n);
}

/** Acidente de semanas/meses atrás sem sinal grave: não força nem UPA. */
export function acidenteAntigoSemGravidade(texto: string): boolean {
  const n = normalizarTexto(texto);
  return ANTIGO.test(n) && !SINAL_GRAVE.test(n);
}

export const TEXTO_ACIDENTE_RECENTE =
  '🚗 Depois de um acidente de trânsito, mesmo sentindo-se bem, é importante ser avaliado *ainda hoje* numa *UPA 24h* — algumas lesões internas só aparecem horas depois.\n\n' +
  '*Ligue 192 na hora* se surgir: dor forte na barriga ou barriga endurecida, falta de ar, vômito, sonolência ou confusão, dor de cabeça forte, dormência ou fraqueza nos braços ou pernas.';
