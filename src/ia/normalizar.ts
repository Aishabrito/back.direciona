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
  const n = normalizarTexto(texto);
  return termos.some((termo) => n.includes(normalizarTexto(termo)));
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
