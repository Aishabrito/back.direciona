// src/ia/guarda_critica.ts
// Guarda de segurança que roda ANTES do LLM. Redundância intencional:
// se o LLM falhar em ver o óbvio, a guarda pega.
//
// Enxuta de propósito — só as categorias mais críticas e só frases
// inequívocas. Se casar, escala DIRETO (sem pergunta, sem LLM).
// Casos ambíguos (desmaio passado, febre em bebê, queimadura, etc.) ficam
// com o LLM decisor + o piso determinístico da validação final.

import { normalizarTexto } from './normalizar.js';

export type CategoriaCritica =
  | 'suicidio'
  | 'pcr'
  | 'engasgo'
  | 'afogamento'
  | 'dor_toracica'
  | 'falta_de_ar'
  | 'avc'
  | 'trauma_craniano'
  | 'convulsao'
  | 'sangramento';

export type ResultadoGuard =
  | { critico: true; motivo: string; categoria: CategoriaCritica; terceiro: boolean }
  | { critico: false };

function ehSobreTerceiro(n: string): boolean {
  return /\b(meu|minha|nosso|nossa|o|a)\s+(pai|mae|filho|filha|marido|esposo|esposa|namorado|namorada|avo|vo|irmao|irma|tio|tia|primo|prima|amigo|amiga|vizinho|vizinha|colega|bebe|crianca|menino|menina|idoso|idosa|senhor|senhora)\b/.test(n)
    || /\b(alguem|uma pessoa|um homem|uma mulher)\b/.test(n);
}

// Pergunta educativa ("o que fazer em caso de falta de ar?") não é emergência ativa.
function ehPerguntaEducativa(n: string, original: string): boolean {
  const pergunta =
    /\?/.test(original) ||
    /^(o que|oq|como|quando|qual|quais|pra que|para que)\b/.test(n);
  if (!pergunta) return false;
  const educativa = /\b(o que e|o que sao|oq e|o que fazer (em caso|quando|se)|como (identificar|reconhecer|saber|funciona)|quais (os|sao os) sinais|sinais de|sintomas de|significa|diferenca)\b/.test(n);
  const primeiraPessoaAgora = /\b(estou|to|tou|sinto|meu|minha|agora|esta com|ta com)\b/.test(n);
  return educativa && !primeiraPessoaAgora;
}

type Regra = { categoria: CategoriaCritica; motivo: string; re: RegExp };

const REGRAS: Regra[] = [
  {
    categoria: 'suicidio',
    motivo: 'risco de autoagressão',
    re: /\b(quero me matar|vou me matar|quer se matar|vai se matar|quero morrer|nao quero mais viver|nao quero viver|acabar com (a )?minha vida|tirar (a )?minha (propria )?vida|me matar|suicid\w*|melhor (eu )?morrer|nao vale a pena viver|queria estar mort[oa]|tentou se matar)\b/,
  },
  {
    categoria: 'pcr',
    motivo: 'parada cardiorrespiratória',
    // "não respira" só conta se NÃO vier seguido de bem/direito/pelo nariz (nariz entupido ≠ PCR)
    re: /\b(parada cardiaca|parou o coracao|coracao parou|sem pulso|sem batimento|parou de respirar|nao (esta |ta )?respira(ndo)?( mais)?(?! (bem|direito|pelo|pela|muito|normal)))\b/,
  },
  {
    categoria: 'engasgo',
    motivo: 'engasgo',
    re: /\b(engasgad[oa]|engasgou|engasgando|engasguei|entalad[oa] com|entalou com|sufocando com comida)\b/,
  },
  {
    categoria: 'afogamento',
    motivo: 'afogamento',
    re: /\b(afogamento|afogou|afogando|se afogou|quase afogou|tirei da (agua|piscina) desacordad[oa])\b/,
  },
  {
    // Diretriz SBC/MS: dor torácica aguda → SAMU sem esperar outros sinais.
    categoria: 'dor_toracica',
    motivo: 'dor torácica',
    re: /\b(dor (no|do|de)?\s*peito|dor toracica|aperto (no|do)\s*peito|peito apertado|pressao (no|do)\s*peito|peso (no|do)\s*peito|peito doendo|doendo o peito|dor (no|do)\s*coracao|pontada (no|do)\s*peito|peito apertando)\b/,
  },
  {
    categoria: 'falta_de_ar',
    motivo: 'falta de ar',
    re: /\b(falta de ar|nao consigo respirar|nao (esta|ta|to|tou|estou) conseguindo respirar|nao consegue respirar|dificuldade (para|pra|de) respirar|sufocando|sem ar|nao entra ar|garganta fechando|labios? (roxos?|arroxeados?))\b/,
  },
  {
    categoria: 'avc',
    motivo: 'sinais neurológicos súbitos',
    re: /\b(boca torta|rosto torto|sorriso torto|fala enrolada|fala embolada|nao consegue falar|fraqueza (em |de )?(um|1) lado|lado do corpo (fraco|mole|dormente)|nao mexe (o |a )?(braco|perna)|perdeu a forca (do|de um|no) (braco|lado)|perda subita de visao)\b/,
  },
  {
    categoria: 'trauma_craniano',
    motivo: 'trauma craniano',
    re: /\b(bati a cabeca|bateu a cabeca|bati com a cabeca|bateu com a cabeca|pancada na cabeca|caiu de altura|trauma craniano|cabeca aberta|corte (profundo )?na cabeca|sangrando (na|a) cabeca|sangue na cabeca)\b/,
  },
  {
    // Só crise ATIVA ou recém-ocorrida — "tremendo de frio" não entra.
    categoria: 'convulsao',
    motivo: 'convulsão',
    re: /\b(convulsao|convulsionando|convulsionou|ataque epileptico|crise epileptica|crise convulsiva|espumando pela boca)\b/,
  },
  {
    categoria: 'sangramento',
    motivo: 'sangramento importante',
    re: /\b(sangramento intenso|hemorragia|sangrando muito|muito sangue|nao para de sangrar|sangramento que nao para|vomitando sangue|vomitei sangue)\b/,
  },
];

export function detectarCriticoRegex(texto: string): ResultadoGuard {
  const n = normalizarTexto(texto);
  if (!n || ehPerguntaEducativa(n, texto)) return { critico: false };

  for (const r of REGRAS) {
    const m = r.re.exec(n);
    if (!m) continue;
    // Negação logo antes ("não tenho dor no peito", "sem falta de ar")
    const antes = n.slice(0, m.index).trim().split(/\s+/).slice(-2);
    if (r.categoria !== 'pcr' && antes.some((p) => /^(nao|sem|nunca|nem|nenhum|nenhuma)$/.test(p))) continue;
    return { critico: true, motivo: r.motivo, categoria: r.categoria, terceiro: ehSobreTerceiro(n) };
  }
  return { critico: false };
}

// ═══════════════════════════════════════════════════════════
// TEXTOS DE EMERGÊNCIA (aprovados — nunca gerados por LLM)
// Fonte: Ministério da Saúde, ABE, AHA, SBC. NUNCA nomeiam doença.
// ═══════════════════════════════════════════════════════════
const TEXTO_PROPRIO: Record<CategoriaCritica, string> = {
  suicidio:
    '💛 Estou aqui com você. Se você está pensando em se machucar, ligue agora para o *CVV 188* (24h, gratuito, sigiloso). Em perigo imediato, ligue *192 (SAMU)* ou vá a uma UPA. Se puder, chame alguém de confiança para ficar com você.',
  pcr: '',
  engasgo:
    '⚠️ Se você está engasgado e não consegue respirar, falar ou tossir, peça ajuda a alguém próximo agora e ligue *192 (SAMU)*. Se consegue tossir, continue tossindo com força.',
  afogamento: '',
  dor_toracica:
    '⚠️ Dor no peito precisa de atendimento imediato. Ligue *192 (SAMU)* agora. Não espere passar e não dirija sozinho.',
  falta_de_ar:
    '⚠️ Falta de ar precisa de atendimento imediato. Ligue *192 (SAMU)* agora ou vá imediatamente à UPA mais próxima. Não dirija sozinho.',
  avc:
    '⚠️ Esses sinais precisam de atendimento imediato. Ligue *192 (SAMU)* agora. Anote a hora em que começou — isso é importante para o tratamento.',
  trauma_craniano:
    '⚠️ Pancada na cabeça precisa de avaliação imediata. Ligue *192 (SAMU)* ou vá agora a uma UPA/Pronto-Socorro, principalmente se houver vômito, sonolência, confusão, dor de cabeça forte ou sangramento.',
  convulsao:
    '⚠️ Essa situação precisa de atendimento imediato. Ligue *192 (SAMU)* agora.',
  sangramento:
    '⚠️ Sangramento importante precisa de atendimento imediato. Ligue *192 (SAMU)* agora. Enquanto isso, faça pressão firme sobre o local com um pano limpo.',
};

const PROTOCOLO: Partial<Record<CategoriaCritica, string>> = {
  pcr: `⚠️ *Ligue 192 (SAMU) agora* — ou peça para alguém ligar.

*Se a pessoa não responde e não respira normalmente:*
1. Comprima o centro do peito com força, *100 a 120 vezes por minuto*, sem parar.
2. Se souber: 30 compressões + 2 ventilações.
3. Se houver DEA (desfibrilador) por perto, use seguindo as instruções do aparelho.
4. Continue até o SAMU chegar.`,
  afogamento: `⚠️ *Ligue 192 (SAMU) agora.* Não entre na água sem treinamento — jogue algo que boie.

*Quando retirar a pessoa:*
1. Se *não respira*: inicie compressões no peito e mantenha até o SAMU chegar.
2. Se *respira*: deite de lado e mantenha aquecida.
3. Mesmo que pareça bem, precisa de avaliação — pode piorar depois.`,
  engasgo: `⚠️ *Enquanto a pessoa está engasgada:*

1. Se ela *consegue tossir ou falar*: incentive a tossir. Não bata nas costas.
2. Se *NÃO consegue respirar, falar ou tossir*: fique atrás dela, abrace, punho fechado acima do umbigo, comprima para dentro e para cima.
3. Em *bebês (menos de 1 ano)*: 5 golpes nas costas + 5 compressões no peito.
4. Em *gestante ou pessoa obesa*: compressões no peito, não no abdômen.
5. Se perder a consciência: ligue *192* e inicie compressões no peito.`,
  convulsao: `⚠️ *Ligue 192 (SAMU).* Enquanto a crise acontece:

1. *Proteja a cabeça* com algo macio e afaste objetos.
2. *Não coloque nada na boca* e não segure braços e pernas.
3. *Anote a hora* que começou.
4. Quando a crise passar, deite a pessoa de lado e fique com ela.`,
  avc: `⚠️ *Ligue 192 (SAMU) agora.* Enquanto o SAMU não chega:

1. *Anote a hora exata* que os sintomas começaram.
2. *NÃO dê água, comida ou remédio.*
3. Deite a pessoa de lado, com a cabeça levemente elevada.
4. Afrouxe roupas apertadas.`,
  trauma_craniano: `⚠️ *Ligue 192 (SAMU).* Enquanto o SAMU não chega:

1. *Mantenha a pessoa deitada e imóvel* — não deixe levantar nem andar.
2. *NÃO remova objetos encravados.*
3. Se sangrar, faça pressão leve ao redor do ferimento com pano limpo.
4. Se vomitar ou perder a consciência, deite de lado.`,
  sangramento: `⚠️ *Ligue 192 (SAMU).* Enquanto isso:

1. Faça *pressão direta e firme* com pano limpo sobre o ferimento.
2. *NÃO retire objetos encravados.*
3. Se possível, eleve o membro acima do nível do coração.
4. Não use pó de café, pasta ou manteiga.`,
  dor_toracica:
    '⚠️ Dor no peito precisa de atendimento imediato. *Ligue 192 (SAMU) agora.* Deixe a pessoa em repouso, sentada ou deitada, e não deixe que ela dirija.',
  falta_de_ar:
    '⚠️ Falta de ar precisa de atendimento imediato. *Ligue 192 (SAMU) agora.* Deixe a pessoa sentada, em repouso, e afrouxe roupas apertadas.',
};

/** Texto aprovado para a categoria. Protocolos de primeiros socorros quando é outra pessoa (ou PCR/afogamento). */
export function textoEmergencia(categoria: CategoriaCritica, terceiro: boolean): string {
  if (categoria === 'pcr' || categoria === 'afogamento') return PROTOCOLO[categoria]!;
  if (terceiro && PROTOCOLO[categoria]) return PROTOCOLO[categoria]!;
  return TEXTO_PROPRIO[categoria];
}

export function destinoDaCategoria(categoria: CategoriaCritica): 'SAMU_192' | 'CVV' {
  return categoria === 'suicidio' ? 'CVV' : 'SAMU_192';
}
