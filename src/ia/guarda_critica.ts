// src/ia/guarda_critica.ts
// Guarda de segurança que roda ANTES do LLM. Redundância intencional:
// se o LLM falhar em ver o óbvio, a guarda pega.
//
// Enxuta de propósito — só as categorias mais críticas e só frases
// inequívocas. Se casar, escala DIRETO (sem pergunta, sem LLM).
// Casos ambíguos (desmaio passado, febre em bebê, queimadura comum, etc.) ficam
// com o LLM decisor + o piso determinístico da validação final.

import { normalizarTexto } from './normalizar.js';
import { acidentePassadoSemGravidade } from './acidente.js';

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
  | 'sangramento'
  | 'trauma_grave'
  | 'inconsciente'
  | 'cefaleia_alarme'
  | 'queimadura_grave'
  | 'intoxicacao'
  | 'anafilaxia'
  | 'hipoglicemia';

export type ResultadoGuard =
  | { critico: true; motivo: string; categoria: CategoriaCritica; terceiro: boolean }
  | { critico: false };

function ehSobreTerceiro(n: string): boolean {
  return /\b(meu|minha|nosso|nossa|o|a)\s+(pai|mae|filho|filha|marido|esposo|esposa|namorado|namorada|avo|vo|irmao|irma|tio|tia|primo|prima|amigo|amiga|vizinho|vizinha|colega|bebe|crianca|menino|menina|idoso|idosa|senhor|senhora)\b/.test(n)
    || /\b(alguem|uma pessoa|um homem|uma mulher|ele|ela|motoqueiro|motociclista|motorista|pedestre|ciclista|rapaz|moca|garoto|garota|vitima)\b/.test(n);
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
    // Antes de suicídio: tentativa com remédio/veneno precisa de SAMU primeiro (o texto cita o CVV).
    categoria: 'intoxicacao',
    motivo: 'intoxicação / ingestão perigosa',
    re: /\b((tomei|tomou|tomaram|engoli|engoliu|bebi|bebeu|ingeriu|ingeri) [^.!?]{0,25}(cartela|caixa|vidro|frasco|pote) (inteir[oa]|tod[oa])|(tomei|tomou|engoli|engoliu|ingeriu) (muitos|varios|um monte de|todos os|todas as|[1-9]\d+) (comprimidos|remedios|capsulas|pilulas)|overdose|(bebeu|bebi|engoliu|engoli|tomou|tomei|ingeriu|ingeri) [^.!?]{0,15}(agua sanitaria|cloro|soda caustica|veneno|chumbinho|raticida|querosene|gasolina|thinner|solvente|desinfetante|produto de limpeza|inseticida|agrotoxico|removedor|acido)|engoliu (uma |um )?(bateria|pilha|ima|bateria de relogio)|envenenad[oa]|envenenamento)\b/,
  },
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
    categoria: 'anafilaxia',
    motivo: 'reação alérgica grave',
    re: /\b((inchaco|inchou|inchad[oa]|inchando) (na |da |a )?(lingua|glote)|(lingua|glote) (esta |ta |ficou |comecou a )?(inchando|inchad[oa]|inchou|inchar)|choque anafilatico|anafilaxia|reacao alergica grave)\b/,
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
    re: /\b((bati|bateu|batemos|machuquei|machucou) (a |na |com a |minha |sua |a sua )?cabeca|pancada na cabeca|trauma craniano|cabeca aberta|corte (profundo )?na cabeca|sangrando (na|a) cabeca|sangue na cabeca)\b/,
  },
  {
    categoria: 'trauma_grave',
    motivo: 'trauma grave',
    re: /\b(acidente (de|com) (moto|carro|transito|onibus|caminhao|bicicleta|bike)|batida de (moto|carro)|(bati|bateu|capotei|capotou) (o|a|com o|com a|de) (carro|moto)|(cai|caiu) (da|de) moto|atropelad[oa]|atropelamento|atropelou|capotou|capotamento|fratura exposta|osso (aparecendo|exposto|pra fora|para fora)|esfaquead[oa]|levou (uma )?facada|levou (um )?tiro|baleado|baleada|caiu de (altura|laje|telhado|andaime|escada)|queda de altura)\b/,
  },
  {
    // Antes de "inconsciente": diabético confuso/desmaiado recebe o protocolo do açúcar.
    categoria: 'hipoglicemia',
    motivo: 'possível glicose baixa grave',
    re: /\b(glicose|glicemia|diabetic[oa]|diabete|diabetes|hipoglicemia|insulina)\b[^.!?]{0,40}\b(confus[oa](?! (com|sobre|em relacao))|desmai\w*|desacordad[oa]|nao responde|nao acorda|muito sonolent[oa]|convulsion\w*|falando enrolado|falando coisa sem sentido)\b/,
  },
  {
    // Estado ATUAL de inconsciência. "Desmaiei ontem" (passado) fica com o LLM.
    categoria: 'inconsciente',
    motivo: 'pessoa inconsciente',
    re: /\b(desmaiad[oa]|desacordad[oa]|inconsciente|nao acorda|nao ta acordando|nao esta acordando|nao responde|nao reage|nao esta reagindo|apagad[oa] no chao)\b/,
  },
  {
    // Dor de cabeça "trovão" (súbita e explosiva) ou rigidez de nuca: sangramento cerebral / meningite.
    categoria: 'cefaleia_alarme',
    motivo: 'dor de cabeça com sinal de alarme',
    re: /\b(pior dor de cabeca (da|de) (minha )?vida|dor de cabeca (muito forte|fortissima|insuportavel|explosiva|absurda)[^.!?]{0,25}(de repente|do nada|subit\w*|de uma vez)|dor de cabeca (de repente|subita|do nada)[^.!?]{0,15}(muito forte|fortissima|insuportavel|explosiva)|(pescoco|nuca) (duro|dura|rigid\w*|travad\w*)|rigidez (na|de|no) (nuca|pescoco)|nao consigo (dobrar|abaixar|encostar)[^.!?]{0,20}(pescoco|queixo|cabeca))\b/,
  },
  {
    // Só a queimadura inequivocamente grave: elétrica, química, fumaça, extensa ou carbonizada.
    // Queimadura com bolha / no rosto / nas mãos fica com o piso de UPA (validacao_final).
    // "Queimando" (xixi queimando, estômago queimando) NÃO entra.
    categoria: 'queimadura_grave',
    motivo: 'queimadura grave',
    re: /\b(queimadura (quimica|eletrica|por choque|por acido|por soda|de soda|de terceiro grau|de 3 grau|de 3o grau|no corpo todo|extensa|enorme|muito grande)|(queimou|queimei|queimad[oa]|caiu|jogou|jogaram) [^.!?]{0,20}(acido|soda caustica|produto quimico)|(acido|soda caustica|produto quimico|agua sanitaria|cloro) (no|nos|na) (olho|olhos|rosto|cara)|eletrocutad[oa]|choque (de|na|no) (alta tensao|fio do poste|poste|rede eletrica)|(levou|tomou|levei|tomei) (um )?choque [^.!?]{0,20}(desmai\w*|apagou|parou|poste|alta tensao|fio de alta)|atingid[oa] por (um )?raio|(pegou|pegando|pegaram) fogo (na roupa|no corpo|nele|nela|em mim|no cabelo)|(inalou|respirou|engoliu) (muita )?fumaca|pele (carbonizada|preta de queimad\w*)|ficou carbonizad[oa])\b/,
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
    // "bati o carro ontem, estou bem" não é SAMU agora — a validação garante no mínimo UPA.
    if (r.categoria === 'trauma_grave' && !/fratura|osso|facad|esfaquead|tiro|balead|atropel/.test(m[0])
        && acidentePassadoSemGravidade(n)) continue;
    if (r.categoria === 'afogamento' && afogamentoPassadoEstavel(n)) continue;
    if (r.categoria === 'sangramento' && sangramentoNasalSemGravidade(n)) continue;
    if (r.categoria === 'convulsao' && criseHabitualJaPassou(n)) continue;
    return { critico: true, motivo: r.motivo, categoria: r.categoria, terceiro: ehSobreTerceiro(n) };
  }
  return { critico: false };
}

// "Quase se afogou ontem, está bem" → não é SAMU agora; a validação garante UPA (sinais tardios).
export function afogamentoPassadoEstavel(n: string): boolean {
  return /\b(ontem|mais cedo|hoje cedo|de manha|a tarde|semana passada|ha \d+ horas?|horas atras|no fim de semana)\b/.test(n)
    && /\b(esta bem|ta bem|parece bem|ficou bem|acordad[oa]|consciente|respirando normal|brincando)\b/.test(n)
    && !/\b(nao respira|desacordad|inconsciente|roxo|roxa|falta de ar|sonolent|confus)/.test(n);
}

// Sangramento pelo nariz sem sinal de choque → piso de UPA/orientação, não SAMU direto.
export function sangramentoNasalSemGravidade(n: string): boolean {
  return /\b(nariz|nasal)\b/.test(n)
    && !/\b(desmai\w*|tont\w*|fraco|fraca|palid\w*|vomit\w*|pancada|bateu|batida|acidente|queda|caiu)\b/.test(n);
}

// Pessoa com epilepsia conhecida, crise igual às de sempre, que já passou e acordou → LLM decide (UBS/UPA).
export function criseHabitualJaPassou(n: string): boolean {
  return /\b(epilep\w*|tem crises?|crise de sempre|crises? (convulsivas? )?(desde|ha anos))\b/.test(n)
    && /\b(ja passou|passou|acabou|ja acordou|acordou|esta bem|ta bem|igual (as|a|aos) de sempre|como sempre|a de sempre)\b/.test(n)
    && !/\b(mais de (5|cinco)|nao para|nao parou|outra crise|em seguida|seguidas|primeira vez|bateu a cabeca|machucou|gravida|gestante|nao acorda|nao respira|roxo|roxa|diferente)\b/.test(n);
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
  cefaleia_alarme:
    '⚠️ Dor de cabeça muito forte que começa de repente, ou com pescoço duro, precisa de atendimento imediato. Ligue *192 (SAMU)* agora ou vá já a um Pronto-Socorro. Não tome remédio por conta própria e não dirija.',
  queimadura_grave:
    '⚠️ Queimadura desse tipo precisa de atendimento imediato. Ligue *192 (SAMU)* agora. Enquanto isso, lave/resfrie com *água corrente em temperatura ambiente* (não use gelo) e cubra com pano limpo. Não passe manteiga, pasta de dente, pó de café nem pomada, e não estoure bolhas.',
  intoxicacao:
    '⚠️ Ligue *192 (SAMU)* agora. *Não provoque vômito* e não tome leite, óleo nem outro líquido. Separe a embalagem do produto ou remédio para mostrar à equipe. Orientação 24h: *Disque-Intoxicação 0800 722 6001*. Se tomou de propósito porque está sofrendo, o *CVV 188* também está aqui para você.',
  anafilaxia:
    '⚠️ Inchaço na língua ou na garganta é emergência. Ligue *192 (SAMU)* agora. Se você tem caneta de adrenalina receitada, use agora na coxa. Fique sentado se estiver com falta de ar.',
  hipoglicemia:
    '⚠️ Ligue *192 (SAMU)*. Se a pessoa está acordada e consegue engolir, dê *açúcar agora*: 1 colher de sopa em meio copo de água, ou meio copo de suco ou refrigerante comum (não diet). Se estiver sonolenta demais ou desacordada, *não dê nada pela boca* e deite de lado.',
  trauma_grave:
    '⚠️ Acidente com ferimento precisa de atendimento imediato. Ligue *192 (SAMU)* agora. Se sentir dor no pescoço ou nas costas, *não se mexa* até a equipe chegar. Se alguém estiver preso nas ferragens ou houver fogo, ligue também *193 (Bombeiros)*.',
  inconsciente:
    '⚠️ Pessoa desacordada precisa de atendimento imediato. Ligue *192 (SAMU)* agora.',
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
5. Não tente tirar o objeto com o dedo se não estiver vendo ele.
6. Se perder a consciência: ligue *192* e inicie compressões no peito.`,
  convulsao: `⚠️ *Ligue 192 (SAMU).* Enquanto a crise acontece:

1. *Proteja a cabeça* com algo macio e afaste objetos.
2. *Não coloque nada na boca* e não segure braços e pernas.
3. *Anote a hora* que começou.
4. Quando a crise passar, deite a pessoa de lado e fique com ela.
5. Em criança com febre: tire o excesso de roupa. *Não dê banho nem remédio pela boca durante a crise.*`,
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
  trauma_grave: `⚠️ *Ligue 192 (SAMU) agora.* Se houver alguém preso nas ferragens, fogo ou vazamento, ligue também *193 (Bombeiros)*.

*Enquanto a ajuda não chega:*
1. *Proteja o local*: pisca-alerta, triângulo ou peça para alguém sinalizar a pista. Desligue o motor do veículo.
2. *NÃO mova a pessoa* (pode haver lesão na coluna) e *NÃO tire o capacete*.
3. Se estiver sangrando, faça *pressão firme* com pano limpo.
4. Se houver osso aparecendo, *não tente colocar no lugar* — cubra com pano limpo.
5. Não dê água nem comida. Fique com a pessoa e converse com ela.`,
  inconsciente: `⚠️ *Ligue 192 (SAMU) agora.* Enquanto o SAMU não chega:

1. Chame a pessoa em voz alta e toque nos ombros.
2. Veja se o peito sobe e desce (se está respirando).
3. *Se NÃO respira*: comprima o centro do peito com força, 100 a 120 vezes por minuto, sem parar.
4. *Se respira* e não houve queda ou acidente: deite de lado. Se houve acidente, *não mova*.
5. Não dê água, comida ou remédio.`,
  queimadura_grave: `⚠️ *Ligue 192 (SAMU) agora.* Enquanto a ajuda não chega:

1. *Afaste da fonte.* Em choque elétrico, *desligue a energia antes de tocar* na pessoa.
2. *Produto químico:* tire a roupa atingida e lave com *muita água corrente por 20 minutos*. No olho, lave sem parar.
3. *Fogo/água quente:* resfrie com água corrente em temperatura ambiente por até 20 minutos. *Não use gelo.* Se a queimadura for grande, cubra com pano limpo e mantenha a pessoa aquecida.
4. Tire anéis, relógios e roupas apertadas que não estejam grudados na pele.
5. *NÃO* passe manteiga, pasta de dente, pó de café nem pomada, e *não estoure bolhas*.
6. Se inalou fumaça, leve para o ar livre e observe a respiração.`,
  intoxicacao: `⚠️ *Ligue 192 (SAMU) agora.* Orientação especializada 24h: *Disque-Intoxicação 0800 722 6001*.

1. *NÃO provoque vômito* e não dê leite, óleo, água com sal nem nada pela boca.
2. *Separe a embalagem*, o frasco ou a cartela e leve junto (ou tire foto).
3. Anote *o que foi, quanto e a que horas*.
4. Se o produto caiu na pele ou nos olhos, lave com muita água corrente por 15 a 20 minutos.
5. Se a pessoa estiver sonolenta, deite de lado. Se não respirar, comece compressões no peito.
6. Se foi de propósito, fique junto da pessoa. Depois, o *CVV 188* pode ajudar.`,
  anafilaxia: `⚠️ *Ligue 192 (SAMU) agora.*

1. Se a pessoa tem *caneta de adrenalina* receitada, use agora na parte de fora da coxa.
2. Se tiver falta de ar, deixe sentada. Se estiver tonta ou fraca, deite com as pernas elevadas.
3. Afaste o que causou a reação (picada, comida, remédio) e não dê nada pela boca.
4. Se parar de respirar, comece compressões no peito.`,
  hipoglicemia: `⚠️ *Ligue 192 (SAMU).* Enquanto isso:

1. *Se está acordada e consegue engolir:* dê açúcar agora (1 colher de sopa em meio copo de água, ou meio copo de suco ou refrigerante comum, não diet).
2. *Se está muito sonolenta, desacordada ou convulsionando:* *não dê nada pela boca.* Deite de lado.
3. Se tiver aparelho, meça a glicose e diga o valor à equipe.
4. Se não respirar, comece compressões no peito.`,
  dor_toracica:
    '⚠️ Dor no peito precisa de atendimento imediato. *Ligue 192 (SAMU) agora.* Deixe a pessoa em repouso, sentada ou deitada, e não deixe que ela dirija.',
  falta_de_ar:
    '⚠️ Falta de ar precisa de atendimento imediato. *Ligue 192 (SAMU) agora.* Deixe a pessoa sentada, em repouso, e afrouxe roupas apertadas.',
};

/** Texto aprovado para a categoria. Protocolos de primeiros socorros quando é outra pessoa (ou PCR/afogamento). */
export function textoEmergencia(categoria: CategoriaCritica, terceiro: boolean): string {
  // Quem está desacordado não está digitando: é sempre sobre outra pessoa.
  if (categoria === 'pcr' || categoria === 'afogamento' || categoria === 'inconsciente') return PROTOCOLO[categoria]!;
  if (terceiro && PROTOCOLO[categoria]) return PROTOCOLO[categoria]!;
  return TEXTO_PROPRIO[categoria];
}

export function destinoDaCategoria(categoria: CategoriaCritica): 'SAMU_192' | 'CVV' {
  return categoria === 'suicidio' ? 'CVV' : 'SAMU_192';
}
