// src/ia/guarda_critica.ts
// Guarda de segurança que roda ANTES do LLM.
// Detecta sintomas críticos via regex independente.
// Se detectar, o orquestrador desvia direto pra emergência.
// Isso NÃO depende do LLM — é a rede de segurança máxima.
//
// IMPORTANTE: a guarda detecta CATEGORIAS internas (para logs/roteamento),
// mas NUNCA nomeia doença pro usuário. As respostas (em orquestrador.ts)
// são puramente direcionamento a serviço.

import { normalizarTexto } from './normalizar.js';

export type CategoriaCritica =
  | 'suicidio'
  | 'dor_toracica'
  | 'falta_de_ar'
  | 'avc'
  | 'desmaio'
  | 'convulsao'
  | 'sangramento'
  | 'bebe_febre'
  | 'obstetrico';

export type SinalCriticoGuard = {
  critico: true;
  motivo: string;
  categoria: CategoriaCritica;
};

export type ResultadoGuard = SinalCriticoGuard | { critico: false };

function norm(texto: string): string {
  return normalizarTexto(texto);
}

export function detectarCriticoRegex(texto: string): ResultadoGuard {
  const n = norm(texto);

  // ─── Ideação suicida ───
  if (
    /\b(quero me matar|vou me matar|quero morrer|nao quero mais viver|nao quero viver|acabar com (a )?minha vida|vou acabar com tudo|me matar|suicid|tirar minha vida|nao vejo mais sentido|melhor morrer|nao vale a pena viver|quero desaparecer|queria estar morto)\b/.test(n)
  ) {
    return { critico: true, motivo: 'risco de autoagressão', categoria: 'suicidio' };
  }

  // ─── Dor torácica ───
  if (
    /\b(dor (no|do|de)?\s*peito|dor toracica|aperto (no|do)\s*peito|peito apertado|pressao (no|do)\s*peito|peso (no|do)\s*peito|peito doendo|ta doendo o peito|esta doendo o peito|dor (no|do)\s*coracao|coracao apertado|pontada (no|do)\s*peito|peito (ta )?apertando|sinto (um )?aperto no peito|sinto (uma )?pressao no peito|sinto (um )?peso no peito|queimacao no peito)\b/.test(n)
  ) {
    return { critico: true, motivo: 'dor torácica', categoria: 'dor_toracica' };
  }

  // ─── Falta de ar ───
  if (
    /\b(falta de ar|falta de respirar|nao consigo respirar|nao (estou )?consigo respirar|nao to conseguindo respirar|nao tou conseguindo respirar|ta dificil respirar|esta dificil respirar|dificuldade (para|pra|de|em) respirar|sufocando|sufocado|sem ar|nao entra ar|nao ta entrando ar|respiracao curta|cansaco (para|pra) respirar|peito fechando|garganta fechando|estou ofegante|falta de oxigenio)\b/.test(n)
  ) {
    return { critico: true, motivo: 'falta de ar', categoria: 'falta_de_ar' };
  }

  // ─── Sinais neurológicos súbitos ───
  if (
    /\b(boca torta|labio torto|rosto torto|face torta|fala enrolada|fala embolada|nao fala direito|nao consegue falar|fraqueza (em |de )?(um|1) lado|lado (do corpo )?(fraco|mole|sem forca)|perdi a forca|perdeu a forca|nao mexe (o |a )?(braco|perna)|dormencia (no|na|de) (braco|perna|corpo)|perda (subita )?de visao|nao enxerga (de )?repente|visao (dupla|embacada) (de )?repente|sorriso torto|dificuldade (para|pra) falar)\b/.test(n)
  ) {
    return { critico: true, motivo: 'sinais neurológicos súbitos', categoria: 'avc' };
  }

  // ─── Perda de consciência ───
  if (
    /\b(desmaio|desmaiei|desmaiou|desmaiando|apaguei|apagou|apagando|perdi a consciencia|perdeu a consciencia|inconsciente|caiu duro|caiu desmaiad|deu um branco e caiu|perdi os sentidos|perdeu os sentidos|passou mal e caiu)\b/.test(n)
  ) {
    return { critico: true, motivo: 'perda de consciência', categoria: 'desmaio' };
  }

  // ─── Convulsão ───
  if (
    /\b(convulsao|convulsionando|ataque epileptico|crise epileptica|tremendo todo|tremendo muito|espumando pela boca|corpo tremendo sem parar|tremor incontrolavel)\b/.test(n)
  ) {
    return { critico: true, motivo: 'convulsão', categoria: 'convulsao' };
  }

  // ─── Sangramento importante ───
  if (
    /\b(sangramento intenso|hemorragia|sangrando muito|muito sangue|vomitando sangue|vomitei sangue|vomito com sangue|sangue no vomito|sangue nas fezes|fezes com sangue|fezes pretas|fezes escuras|sangue na urina|sangue no xixi|sangramento que nao para|nao para de sangrar)\b/.test(n)
  ) {
    return { critico: true, motivo: 'sangramento importante', categoria: 'sangramento' };
  }

  // ─── Bebê pequeno com febre ───
  const ehBebe =
    /\b(bebe|recem nascid|recem-nascid|recem nascido|menos de 3 meses|com 3 meses|com 2 meses|com 1 mes|de 2 meses|de 3 meses|de 1 mes|de 2 semana|de 3 semana|de 4 semana)\b/.test(n);
  const temFebre = /\b(febre|febril|temperatura alta|temperatura elevada|quebrado de febre|38|39|40)/.test(n);
  if (ehBebe && temFebre) {
    return { critico: true, motivo: 'bebê pequeno com febre', categoria: 'bebe_febre' };
  }

  // ─── Obstétrico ───
  const ehGestante = /\b(gravida|gestante|estou gravida|to gravida|tou gravida|prenha|gestacao)\b/.test(n);
  const temSangramento = /\b(sangramento|sangrando|sangrou|sangue|perda de sangue)\b/.test(n);
  const temContracao = /\b(contracao|contracoes|contraindo|dor de parto|trabalho de parto|bolsa rota)\b/.test(n);
  const temPerdaLiquido = /\b(bolsa estourou|perda de liquido|rompeu a bolsa|saiu agua|perdi liquido|perdendo liquido)\b/.test(n);
  const temReducaoMov = /\b(bebe (parou|nao mexe|nao se mexe)|nao sinto (o )?bebe|bebe quieto|nao sinto mexer)\b/.test(n);

  if (ehGestante && (temSangramento || temContracao || temPerdaLiquido || temReducaoMov)) {
    return { critico: true, motivo: 'sinal obstétrico de risco', categoria: 'obstetrico' };
  }

  return { critico: false };
}

export function temPalavrasClinicas(texto: string): boolean {
  const n = norm(texto);
  return /\b(dor|doendo|doer|sinto|sentindo|sintoma|mal|ruim|enjoo|nausea|tosse|febre|falta|aperto|pressao|peso|inchaco|mancha|ferida|sangue|vomito|diarreia|tontura|falta|tonteira|fraqueza|desmaio|cansaco|falta de ar|dificuldade)\b/.test(n);
}