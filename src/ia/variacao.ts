
// Mensagens variadas pra deixar o bot menos robótico.

export function escolherAleatorio<T>(lista: T[]): T {
  return lista[Math.floor(Math.random() * lista.length)];
}

export const RESETS = [
  '🔄 *Reiniciado.*\n\nMe conta o que está acontecendo ou o que você está sentindo que eu te oriento onde buscar atendimento.',
  '🔄 *Recomeçando.*\n\nPode me contar o que está sentindo que eu te oriento onde buscar atendimento.',
  '🔄 *Ok, do zero.*\n\nO que está acontecendo? Me conta que eu te oriento.',
];
