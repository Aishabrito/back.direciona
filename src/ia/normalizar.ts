export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contemAlgum(texto: string, termos: string[]): boolean {
  const n = ` ${normalizarTexto(texto)} `;
  return termos.some((t) => n.includes(` ${normalizarTexto(t)} `));
}

export function unicos(valores: string[]): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const valor of valores) {
    const chave = normalizarTexto(valor);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(valor);
  }
  return saida;
}

const NEGACOES = /^(nao|sem|nunca|nem|nenhum|nenhuma|nenhuns|nenhumas|jamais)$/;

// Cláusulas separadas por pontuação e conjunções adversativas.
// Impede que "sem febre mas com dor no peito" aplique a negação de "febre"
// em "dor no peito".
const SEPARADOR_CLAUSULAS =
  /\b(mas|por[eé]m|contudo|entretanto|todavia|no entanto|s[oó] que)\b|[,;.!?]|\n/g;

export function dividirClausulas(texto: string): string[] {
  return texto
    .split(SEPARADOR_CLAUSULAS)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Retorna:
 *   true  → alguma cláusula afirma o termo
 *   false → todas as cláusulas que citam o termo o negam
 *   null  → termo ausente
 */
export function afirmado(texto: string, termo: RegExp): boolean | null {
  const clausulas = dividirClausulas(texto);
  let viuNegacao = false;

  for (const c of clausulas) {
    const m = termo.exec(c);
    if (!m) continue;
    const antes = c.slice(0, m.index).trim().split(/\s+/).slice(-4);
    const negado = antes.some((p) => NEGACOES.test(p));
    if (!negado) return true;
    viuNegacao = true;
  }
  return viuNegacao ? false : null;
}

export function afirmadoTri(
  texto: string,
  termo: RegExp,
): boolean | 'nao_informado' {
  const r = afirmado(texto, termo);
  if (r === true) return true;
  if (r === false) return false;
  return 'nao_informado';
}