export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// [FIX] Fronteira de palavra: "dor" não casa em "dormir"; "tiro" não casa em "tiroide"
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

/**
 * Retorna:
 *   true    → termo presente sem negação antes
 *   false   → termo presente COM negação antes ("não tenho febre")
 *   null    → termo ausente
 */
export function afirmado(texto: string, termo: RegExp): boolean | null {
  const m = termo.exec(texto);
  if (!m) return null;
  const antes = texto.slice(0, m.index).trim().split(/\s+/).slice(-4);
  return !antes.some((p) => NEGACOES.test(p));
}

/** Versão tristate — devolve 'nao_informado' quando o termo não aparece. */
export function afirmadoTri(
  texto: string,
  termo: RegExp,
): boolean | 'nao_informado' {
  const r = afirmado(texto, termo);
  if (r === true) return true;
  if (r === false) return false;
  return 'nao_informado';
}