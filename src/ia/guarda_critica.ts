// src/ia/guarda_critica.ts
// Guarda de segurança que roda ANTES do LLM.
// Detecta sintomas críticos via regex independente.
// Diferencia emergência ATIVA (SAMU direto) de PASSADA/AMBÍGUA (triagem + protocolo).

import { normalizarTexto } from './normalizar.js';

export type CategoriaCritica =
  | 'suicidio'
  | 'dor_toracica'
  | 'falta_de_ar'
  | 'avc'
  | 'desmaio'
  | 'convulsao'
  | 'sangramento'
  | 'vomito_sangue'
  | 'bebe_febre'
  | 'obstetrico'
  | 'engasgo'
  | 'pcr'
  | 'afogamento'
  | 'queimadura';

export type SinalCriticoGuard = {
  critico: true;
  motivo: string;
  categoria: CategoriaCritica;
  terceiro: boolean;
};

export type ResultadoGuard = SinalCriticoGuard | { critico: false };

function norm(texto: string): string {
  return normalizarTexto(texto);
}

// Detecta se a mensagem é sobre terceiro (pai, mãe, filho, etc)
function ehSobreTerceiro(n: string): boolean {
  return /\b(meu|minha|nosso|nossa|o|a)\s+(pai|mae|mãe|filho|filha|marido|esposo|esposa|namorado|namorada|avo|avô|avó|vo|vó|irmao|irmão|irma|tio|tia|primo|prima|amigo|amiga|vizinho|vizinh|conhecid|colega|bebe|bebê|crianca|criança|menino|menina|idoso|idosa|senhor|senhora|alguem|alguém)\b/.test(n);
}

export function detectarCriticoRegex(texto: string): ResultadoGuard {
  const n = norm(texto);
  const terceiro = ehSobreTerceiro(n);

  // ─── Ideação suicida ───
  if (
    /\b(quero me matar|vou me matar|quero morrer|nao quero mais viver|nao quero viver|acabar com (a )?minha vida|vou acabar com tudo|me matar|suicid|tirar minha vida|nao vejo mais sentido|melhor morrer|nao vale a pena viver|quero desaparecer|queria estar morto)\b/.test(n)
  ) {
    return { critico: true, motivo: 'risco de autoagressão', categoria: 'suicidio', terceiro };
  }

  // ─── PCR / parada cardíaca ───
  if (
    /\b(parada cardiaca|parou o coracao|nao respira mais|parou de respirar|nao respira|sem pulso|sem batimento|coracao parou|esta sem respirar|nao ta respirando|nao esta respirando)\b/.test(n)
  ) {
    return { critico: true, motivo: 'parada cardiorrespiratória', categoria: 'pcr', terceiro };
  }

  // ─── Engasgo ───
  if (
    /\b(engasg|engasgou|engasgando|entalad|entalou|sufocando com comida|comida na garganta|nao consegue engolir|algo na garganta|preso na garganta)\b/.test(n)
  ) {
    return { critico: true, motivo: 'engasgo', categoria: 'engasgo', terceiro };
  }

  // ─── Afogamento ───
  if (
    /\b(afogamento|afogou|afogando|se afogou|quase afogou|caiu na agua|nao sai da agua|esta na agua sem respirar)\b/.test(n)
  ) {
    return { critico: true, motivo: 'afogamento', categoria: 'afogamento', terceiro };
  }

  // ─── Queimadura (recente) ───
  if (
    /\b(queimadura|queimou|queimei|se queimou|queimando|escaldadura|escaldou|agua quente na pele|oleo quente|fogo na pele|acidente com fogo)\b/.test(n)
  ) {
    return { critico: true, motivo: 'queimadura', categoria: 'queimadura', terceiro };
  }

  // ─── Dor torácica ───
  if (
    /\b(dor (no|do|de)?\s*peito|dor toracica|aperto (no|do)\s*peito|peito apertado|pressao (no|do)\s*peito|peso (no|do)\s*peito|peito doendo|ta doendo o peito|esta doendo o peito|dor (no|do)\s*coracao|coracao apertado|pontada (no|do)\s*peito|peito (ta )?apertando|sinto (um )?aperto no peito|sinto (uma )?pressao no peito|sinto (um )?peso no peito|queimacao no peito)\b/.test(n)
  ) {
    return { critico: true, motivo: 'dor torácica', categoria: 'dor_toracica', terceiro };
  }

  // ─── Falta de ar ───
  if (
    /\b(falta de ar|falta de respirar|nao consigo respirar|nao (estou )?consigo respirar|nao to conseguindo respirar|nao tou conseguindo respirar|ta dificil respirar|esta dificil respirar|dificuldade (para|pra|de|em) respirar|sufocando|sufocado|sem ar|nao entra ar|nao ta entrando ar|respiracao curta|cansaco (para|pra) respirar|peito fechando|garganta fechando|estou ofegante|falta de oxigenio)\b/.test(n)
  ) {
    return { critico: true, motivo: 'falta de ar', categoria: 'falta_de_ar', terceiro };
  }

  // ─── Sinais neurológicos súbitos (AVC) ───
  if (
    /\b(boca torta|labio torto|rosto torto|face torta|fala enrolada|fala embolada|nao fala direito|nao consegue falar|fraqueza (em |de )?(um|1) lado|lado (do corpo )?(fraco|mole|sem forca)|perdi a forca|perdeu a forca|nao mexe (o |a )?(braco|perna)|dormencia (no|na|de) (braco|perna|corpo)|perda (subita )?de visao|nao enxerga (de )?repente|visao (dupla|embacada) (de )?repente|sorriso torto|dificuldade (para|pra) falar)\b/.test(n)
  ) {
    return { critico: true, motivo: 'sinais neurológicos súbitos', categoria: 'avc', terceiro };
  }

  // ─── Desmaio / inconsciência ───
  if (
    /\b(desmaio|desmaiei|desmaiou|desmaiando|apaguei|apagou|apagando|perdi a consciencia|perdeu a consciencia|inconsciente|caiu duro|caiu desmaiad|deu um branco e caiu|perdi os sentidos|perdeu os sentidos|passou mal e caiu)\b/.test(n)
  ) {
    return { critico: true, motivo: 'perda de consciência', categoria: 'desmaio', terceiro };
  }

  // ─── Convulsão ───
  if (
    /\b(convulsao|convulsionando|ataque epileptico|crise epileptica|tremendo todo|tremendo muito|espumando pela boca|corpo tremendo sem parar|tremor incontrolavel)\b/.test(n)
  ) {
    return { critico: true, motivo: 'convulsão', categoria: 'convulsao', terceiro };
  }

  // ─── Sangramento importante ───
  if (
    /\b(sangramento intenso|hemorragia|sangrando muito|muito sangue|sangramento que nao para|nao para de sangrar|ferida aberta sangrando|corte profundo sangrando)\b/.test(n)
  ) {
    return { critico: true, motivo: 'sangramento importante', categoria: 'sangramento', terceiro };
  }

  // ─── Vômito com sangue ───
  if (
    /\b(vomitando sangue|vomitei sangue|vomito com sangue|sangue no vomito|vomito com sangue|vomitei com sangue)\b/.test(n)
  ) {
    return { critico: true, motivo: 'sangue no vômito', categoria: 'vomito_sangue', terceiro };
  }

  // ─── Bebê pequeno com febre ───
  const ehBebe =
    /\b(bebe|recem nascid|recem-nascid|recem nascido|menos de 3 meses|com 3 meses|com 2 meses|com 1 mes|de 2 meses|de 3 meses|de 1 mes|de 2 semana|de 3 semana|de 4 semana)\b/.test(n);
  const temFebre = /\b(febre|febril|temperatura alta|temperatura elevada|quebrado de febre|38|39|40)/.test(n);
  if (ehBebe && temFebre) {
    return { critico: true, motivo: 'bebê pequeno com febre', categoria: 'bebe_febre', terceiro: true };
  }

  // ─── Obstétrico ───
  const ehGestante = /\b(gravida|gestante|estou gravida|to gravida|tou gravida|prenha|gestacao)\b/.test(n);
  const temSangramento = /\b(sangramento|sangrando|sangrou|sangue|perda de sangue)\b/.test(n);
  const temContracao = /\b(contracao|contracoes|contraindo|dor de parto|trabalho de parto|bolsa rota)\b/.test(n);
  const temPerdaLiquido = /\b(bolsa estourou|perda de liquido|rompeu a bolsa|saiu agua|perdi liquido|perdendo liquido)\b/.test(n);
  const temReducaoMov = /\b(bebe (parou|nao mexe|nao se mexe)|nao sinto (o )?bebe|bebe quieto|nao sinto mexer)\b/.test(n);

  if (ehGestante && (temSangramento || temContracao || temPerdaLiquido || temReducaoMov)) {
    return { critico: true, motivo: 'sinal obstétrico de risco', categoria: 'obstetrico', terceiro: false };
  }

  return { critico: false };
}

// ═══════════════════════════════════════════════════════════
// Decide se pode fazer pergunta de acompanhamento antes de escalar.
// ═══════════════════════════════════════════════════════════
export function permiteTriagemAntes(
  texto: string,
  categoria: CategoriaCritica,
  terceiro: boolean,
): boolean {
  const n = norm(texto);

  // ─── Terceiro: SEMPRE pergunta primeiro (relato é sempre incompleto) ───
  if (terceiro) return true;

  // ─── Nunca pergunta (SAMU/CVV direto) ───
  if (categoria === 'suicidio') return false;
  if (categoria === 'falta_de_ar') return false;
  if (categoria === 'avc') return false;
  if (categoria === 'sangramento') return false;
  if (categoria === 'pcr') return false;     // PCR sempre direto
  if (categoria === 'afogamento') return false; // afogamento sempre direto

  // ─── Dor torácica: depende de sinal associado ───
  if (categoria === 'dor_toracica') {
    const temSinalAssociado =
      /\b(falta de ar|nao consigo respirar|suor frio|suando muito|desmaio|desmaiei|apaguei|confus|nausea|vomit|tontura|fraqueza (no|em) braco|dor (no|do|de) braco|dor na mandibula|dor nas costas|palidez|palido|roxo|labios roxos)\b/.test(n);
    return !temSinalAssociado;
  }

  // ─── Sempre pergunta (protocolo de primeiros socorros) ───
  if (categoria === 'vomito_sangue') return true;
  if (categoria === 'engasgo') return true;
  if (categoria === 'queimadura') return true;
  if (categoria === 'bebe_febre') return true;

  // ─── Desmaio: pergunta ───
  if (categoria === 'desmaio') {
    if (/\b(inconsciente agora|nao acorda|nao responde|apagad[oa] agora|nao ta respondendo|ainda apagad)\b/.test(n)) {
      return false;
    }
    return true;
  }

  // ─── Convulsão: "agora" → SAMU, senão triagem ───
  if (categoria === 'convulsao') {
    if (/\b(convulsionando agora|ta convulsionando|esta convulsionando|convulsionando neste momento)\b/.test(n)) {
      return false;
    }
    return true;
  }

  // ─── Obstétrico: hemorragia → SAMU, senão triagem ───
  if (categoria === 'obstetrico') {
    if (/\b(hemorragia|sangrando muito|muito sangue|sangramento intenso)\b/.test(n)) {
      return false;
    }
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════
// PROTOCOLOS DE PRIMEIROS SOCORROS
// Fonte: Ministério da Saúde, ABE, AHA, SBC.
// NUNCA nomeia doença. Só instrui + direciona serviço.
// ═══════════════════════════════════════════════════════════
export function protocoloConvulsaoTerceiro(): string {
  return `⚠️ *Enquanto a crise acontece:*

1. *Proteja a cabeça* — coloque algo macio embaixo (toalha, casaco).
2. *Afaste objetos* — móveis e coisas que possam machucar. Tire os óculos e afrouxe a roupa no pescoço.
3. *Anote a hora* que começou. Se durar mais de 5 minutos ou repetir, ligue *192 (SAMU)*.
4. *Não coloque nada na boca* e não tente segurar os braços e pernas.

*Depois que a crise passar*, deite a pessoa de lado (posição lateral de segurança) e fique ao lado dela até acordar bem. Não ofereça água, comida ou remédio.

Me avise quando passar e se a pessoa voltou a ficar consciente.`;
}

export function protocoloEngasgo(): string {
  return `⚠️ *Enquanto a pessoa está engasgada:*

1. Se ela *consegue tossir ou falar*: incentive a tossir. Não bata nas costas.
2. Se *NÃO consegue respirar, falar ou tossir*: fique atrás dela, abrace, punho fechado acima do umbigo, comprima para dentro e para cima.
3. Em *bebês (menos de 1 ano)*: 5 golpes nas costas + 5 compressões no peito.
4. Em *gestante ou pessoa obesa*: compressões no peito, não no abdômen.
5. Se perder a consciência: ligue *192* e inicie RCP.

Ligue *192* se não resolver rápido.`;
}

export function protocoloPCR(): string {
  return `⚠️ *Se a pessoa não responde e não respira:*

1. Ligue *192 (SAMU)* agora, ou peça para alguém ligar.
2. Inicie compressões no centro do peito, *100 a 120 por minuto*, sem parar.
3. Se souber fazer ventilação: 30 compressões + 2 ventilações.
4. Se tiver DEA (desfibrilador) próximo, use seguindo as instruções.
5. Continue até o SAMU chegar.

*Não pare as compressões.*`;
}

export function protocoloAfogamento(): string {
  return `⚠️ *Não entre na água sem treinamento.* Chame *192* e jogue algo flutuante.

*Quando retirar a pessoa:*
1. Se *não respira*: inicie RCP e mantenha até o SAMU chegar.
2. Se *respira*: deite de lado, mantenha aquecida.
3. Mesmo que pareça bem, leve a uma UPA — pode piorar depois.

Ligue *192* agora.`;
}

export function protocoloSangramento(): string {
  return `⚠️ *Enquanto o sangramento não para:*

1. Faça *pressão direta* com pano limpo sobre o ferimento.
2. *NÃO retire objetos encravados* (faca, vidro).
3. Se possível, eleve o membro acima do nível do coração.
4. Se não parar em 10 minutos, ligue *192*.

Não use pó, café, pasta ou manteiga.`;
}

export function protocoloQueimadura(): string {
  return `⚠️ *Cuidados imediatos:*

1. *Água corrente em temperatura ambiente* por cerca de 20 minutos. *NÃO use gelo*.
2. Retire anéis e objetos apertados antes que o inchaço apareça.
3. *NÃO estoure bolhas*, nem passe pasta, manteiga ou pó.
4. Cubra com pano limpo e úmido.

Ligue *192* se for grande, profunda, em rosto/mãos/genitais, ou em bebê/idoso.`;
}

export function protocoloDesmaioTerceiro(): string {
  return `⚠️ *Enquanto a pessoa está desmaiada:*

1. Deite-a de costas e verifique se está respirando.
2. Eleve as pernas (a menos que tenha caído de altura ou batido a cabeça).
3. Afaste objetos.
4. Se recuperar rápido: deixe deitada por alguns minutos.
5. Se *NÃO recuperar em 1 minuto*, não respirar bem, convulsionar ou tiver batido a cabeça: ligue *192*.`;
}

export function protocoloAVCTerceiro(): string {
  return `⚠️ *Enquanto o SAMU não chega:*

1. *Anote a hora exata* que os sintomas começaram. Isso é crítico para o tratamento.
2. Deite a pessoa de lado, com a cabeça levemente elevada.
3. *NÃO dê água, comida ou remédio*.
4. Afrouxe roupas apertadas.
5. Se ela vomitar, mantenha de lado para não engasgar.

Ligue *192* agora.`;
}

// ═══════════════════════════════════════════════════════════
// Retorna a mensagem de triagem/protocolo por categoria.
// NUNCA nomeia doença — só instrui e direciona.
// ═══════════════════════════════════════════════════════════
export function perguntaTriagemCritica(
  categoria: CategoriaCritica,
  terceiro: boolean,
): string | null {
  // ─── PCR e AFOGAMENTO: protocolo mesmo se for a própria pessoa ───
  if (categoria === 'pcr') return protocoloPCR();
  if (categoria === 'afogamento') return protocoloAfogamento();

  // ─── Terceiro: protocolo específico ───
  if (terceiro) {
    if (categoria === 'convulsao') return protocoloConvulsaoTerceiro();
    if (categoria === 'engasgo') return protocoloEngasgo();
    if (categoria === 'desmaio') return protocoloDesmaioTerceiro();
    if (categoria === 'avc') return protocoloAVCTerceiro();
    if (categoria === 'sangramento') return protocoloSangramento();
    if (categoria === 'queimadura') return protocoloQueimadura();
  }

  // ─── Próprio: perguntas simples ou protocolo reduzido ───
  if (categoria === 'dor_toracica') {
    if (terceiro) {
      return `⚠️ *Emergência potencial.* A pessoa está com falta de ar, suor frio ou desmaio agora? Se sim, ligue *192 (SAMU)* imediatamente. Se não, me conta mais.`;
    }
    return `⚠️ *Se for dor forte no peito agora, não espere.* Você está com falta de ar, suor frio ou desmaio junto? Se sim, ligue *192 (SAMU)* agora. Se não, me conta mais.`;
  }

  if (categoria === 'vomito_sangue') {
    return terceiro
      ? `A pessoa ainda está vomitando? Foi muito sangue ou só um pouco?`
      : `Você ainda está vomitando? Foi muito sangue ou só um pouco?`;
  }

  if (categoria === 'desmaio') {
    return `Você voltou a ficar consciente? Está se sentindo tonta ou com fraqueza agora?`;
  }

  if (categoria === 'convulsao') {
    return `A crise já passou? Você está consciente agora?`;
  }

  if (categoria === 'engasgo') {
    return `Você ainda está engasgado? Consegue respirar e falar normalmente agora?`;
  }

  if (categoria === 'queimadura') {
    return protocoloQueimadura();
  }

  if (categoria === 'bebe_febre') {
    return `Há quantos dias o bebê está com febre? Ele está mamando bem e urinando normalmente?`;
  }

  if (categoria === 'obstetrico') {
    return `Quanto sangramento? Está com dor forte, contração ou perda de líquido?`;
  }

  return null;
}

export function temPalavrasClinicas(texto: string): boolean {
  const n = norm(texto);
  return /\b(dor|doendo|doer|sinto|sentindo|sintoma|mal|ruim|enjoo|nausea|tosse|febre|falta|aperto|pressao|peso|inchaco|mancha|ferida|sangue|vomito|diarreia|tontura|falta|tonteira|fraqueza|desmaio|cansaco|falta de ar|dificuldade)\b/.test(n);
}