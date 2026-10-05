// Depois de uma orientação, qual tipo de unidade oferecer para a pessoa buscar
// ("quer saber a UPA mais próxima?"). Usado pelo WhatsApp (bot.ts) e pela API do app.
import type { TipoUsuario } from './geolocalizacao.js';

export const LOCAL_POR_RESPOSTA: Record<string, TipoUsuario> = {
  upa_001: 'UPA', dengue_001: 'UPA', desidratacao_001: 'UPA', intoxicacao_001: 'UPA',
  emergencia_001: 'HOSPITAL', obstetricia_001: 'HOSPITAL', pediatria_emergencia_001: 'HOSPITAL',
  mental_emergencia_001: 'HOSPITAL', violencia_001: 'HOSPITAL',
  ubs_001: 'UBS',
};

/** Tipo de unidade a oferecer para este resultado, ou null se não houver oferta. */
export function tipoParaOferecer(
  resultado: { tipo: string; decisao?: { resposta_id: string } },
): TipoUsuario | null {
  if (resultado.tipo !== 'orientacao' || !resultado.decisao) return null;
  return LOCAL_POR_RESPOSTA[resultado.decisao.resposta_id] ?? null;
}

export function artigoUnidade(tipo: TipoUsuario): { art: string; prox: string; nome: string } {
  if (tipo === 'HOSPITAL') return { art: 'o', prox: 'próximo', nome: 'hospital' };
  return { art: 'a', prox: 'próxima', nome: tipo };
}
