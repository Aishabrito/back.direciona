
// Mensagens variadas pra deixar o bot menos robótico.

export function escolherAleatorio<T>(lista: T[]): T {
  return lista[Math.floor(Math.random() * lista.length)];
}

export const DESPEDIDAS = [
  '💛 Fico à disposição. Cuide-se!',
  'Cuide-se bem! Qualquer coisa é só chamar. 💙',
  'Espero que melhore logo. Estou aqui se precisar. 🌻',
  'Fico à disposição. Qualquer dúvida, me chama. 💛',
];

export const RESETS = [
  '🔄 *Reiniciado.*\n\nMe conta o que está acontecendo ou o que você está sentindo que eu te oriento onde buscar atendimento.',
  '🔄 *Recomeçando.*\n\nPode me contar o que está sentindo que eu te oriento onde buscar atendimento.',
  '🔄 *Ok, do zero.*\n\nO que está acontecendo? Me conta que eu te oriento.',
];

export const ABERTURAS_RAG = [
  'Deixa eu te explicar:',
  'Boa pergunta:',
  'Vou te contar:',
  'Então:',
  'Resumindo:',
];

export const ACOLHIMENTOS_REPETICAO = [
  'Acho que não te ajudei bem antes. Deixa eu tentar de outro jeito:',
  'Parece que a resposta anterior não ajudou. Vou tentar diferente:',
  'Deixa eu reformular:',
];