import { GoogleGenAI, Type } from '@google/genai';
import { contemAlgum, normalizarTexto, unicos, afirmado, afirmadoTri } from './normalizar';
import { RELATO_VAZIO, type RelatoEstruturado } from './tipos';
import { validarRelato } from './validador_de_saida';
import { gerarJSON, type JsonSchema } from '../servicos/ia.js';

const TERCEIROS: Record<string, string> = {
  mae: 'mãe', pai: 'pai', filho: 'filho', filha: 'filha',
  crianca: 'criança', esposo: 'esposo', esposa: 'esposa',
  marido: 'marido', namorado: 'namorado', namorada: 'namorada',
  avo: 'avó', avo_masc: 'avô', irmao: 'irmão', irma: 'irmã',
  vo: 'vô', vo_fem: 'vó',
};

const AUTODIAGNOSTICO: [RegExp, string][] = [
  [/\binfarto\b/, 'infarto'],
  [/\bavc\b|\bderrame\b/, 'avc'],
];

const NEUROLOGICOS: [RegExp, string][] = [
  [/\bboca torta\b|\blabio torto\b|\bface torta\b/, 'boca_torta'],
  [/\bfala enrolada\b|\bnao fala direito\b|\bfala embolada\b|\bnao consegue falar\b/, 'fala_enrolada'],
  [/\bfraqueza (em )?(um|de um) lado\b|\blado do corpo fraco\b|\bnao mexe (o )?braco\b|\bnao mexe (a )?perna\b/, 'fraqueza_unilateral'],
  [/\bperda (s[uú]bita )?de visao\b|\bnao enxerga (de )?repente\b/, 'perda_visao_subita'],
];

function extrairSinaisObstetricos(n: string, gestante: string, posParto: string): string[] {
  if (gestante !== 'sim' && posParto !== 'sim') return [];
  const sinais: string[] = [];
  if (/(contra[cç][oõ]es?|contraindo|dor de parto)/.test(n)) sinais.push('contracoes');
  if (/(bolsa estourou|perda de l[ií]quido|rompeu a bolsa|saiu [aá]gua)/.test(n)) sinais.push('perda_liquido_amniotico');
  if (/(press[aã]o alta|hipertens[aã]o)/.test(n)) sinais.push('pressao_alta');
  if (sinais.includes('pressao_alta') && /dor de cabe[cç]a intensa|vis[aã]o turva|enxaqueca/.test(n)) sinais.push('pre_eclampsia');
  if (/sangramento vaginal|perda de sangue|hemorragia obst[eé]trica/.test(n)) sinais.push('sangramento_obstetrico');
  return sinais;
}

function extrairSinaisTrauma(n: string): string[] {
  const sinais: string[] = [];
  const temAcidente = /\b(atropel|acidente|colis[aã]o|capot|batida|bati|bateu|colidiu)\b/.test(n);
  if (temAcidente && /\b(carro|moto|autom[oó]vel|caminh[aã]o|[oô]nibus)\b/.test(n)) sinais.push('trauma_automobilistico');
  if (/\batropel/.test(n)) sinais.push('trauma_automobilistico');
  if (/queda de altura|queda de [1-9] metros|caiu de [1-9] andar/.test(n)) sinais.push('queda_altura');
  if (
    /arma branca|esfaquead|levou (uma )?facada|levou (uma )?faca\b|levou (um )?tiro|balead|tiro no|arma de fogo|perfura[cç][aã]o por arma/.test(n)
  ) sinais.push('ferimento_perfurante');
  if (/trauma craniano|batida na cabe[cç]a|pancada na cabe[cç]a|bateu a cabe[cç]a/.test(n))
    sinais.push('trauma_craniano');
  return sinais;
}

function extrairNeurologicos(n: string): string[] {
  const sinais: string[] = [];
  for (const [re, label] of NEUROLOGICOS) if (re.test(n)) sinais.push(label);
  return sinais;
}

function extrairFalaFrases(n: string): boolean | 'nao_informado' {
  if (/\bnao consigo respirar\b|\bnao estou conseguindo respirar\b|\bsem conseguir respirar\b/.test(n)) return false;
  if (/\bnao consigo falar\b|\bnao falo\b|\bnao consigo terminar\b|\bnao consigo completar\b|\bnao consigo formar frase\b|\bnao fala frases\b/.test(n)) return false;
  if (/\bconsigo falar\b|\bfalo normal\b|\bconsigo terminar\b|\bconsigo completar\b/.test(n)) return true;
  return 'nao_informado';
}

function ehBebe(n: string, idadeNumerica: number | null): boolean {
  if (idadeNumerica !== null && idadeNumerica < 2) return true;
  if (/\brecem nascid/.test(n)) return true;
  if (/\bmeses de vida\b/.test(n)) return true;
  if (/\b(meu|minha|o|a|nosso|nossa)\s+bebe\b/.test(n)) return true;
  return false;
}

function acharIdade(n: string): { valor: number; unidade: string } | null {
  const re = /\b(\d{1,3})\s*(anos?|meses|mes)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(n)) !== null) {
    const antes = n.slice(0, m.index).trim().split(/\s+/).slice(-3).join(' ');
    const depois = n.slice(m.index + m[0].length).trim().split(/\s+/).slice(0, 1).join(' ');
    const ehDuracao =
      /\b(ha|faz|desde|por|durante|ultimos|ultimas|mais de|quase|uns|umas)$/.test(antes) ||
      /^(atras|de doenca|de tratamento)$/.test(depois);
    if (!ehDuracao) return { valor: parseInt(m[1], 10), unidade: m[2] };
  }
  return null;
}

function extrairIdade(n: string): { grupo: RelatoEstruturado['idade_grupo']; numerica: number | null } {
  const achada = acharIdade(n);
  let numerica: number | null = null;
  if (achada) {
    numerica = achada.unidade.startsWith('mes') ? Math.max(0, Math.round(achada.valor / 12)) : achada.valor;
  }
  const mencionaFilho = contemAlgum(n, [
    'meu filho', 'minha filha', 'nosso filho', 'nossa filha',
    'o filho', 'a filha', 'meu menino', 'minha menina',
  ]);
  const bebe = ehBebe(n, numerica);
  const crianca = !bebe && (
    contemAlgum(n, ['crianca', 'menino', 'menina']) ||
    (numerica !== null && numerica < 12) ||
    (mencionaFilho && numerica === null)
  );
  const adolescente = !bebe && !crianca && (contemAlgum(n, ['adolescente']) || (numerica !== null && numerica < 18));
  const idoso = !bebe && !crianca && !adolescente &&
    (contemAlgum(n, ['idoso', 'velhinho']) || (numerica !== null && numerica >= 65));
  const grupo: RelatoEstruturado['idade_grupo'] =
    bebe ? 'bebe'
    : crianca ? 'crianca'
    : adolescente ? 'adolescente'
    : idoso ? 'idoso'
    : contemAlgum(n, ['adulto']) ? 'adulto'
    : 'nao_informado';
  return { grupo, numerica };
}

const NUM_PALAVRA = '\\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez';

function extrairDuracao(n: string): string {
  const comPrefixo = n.match(
    new RegExp(`\\b(?:ha|faz|desde)\\s+(${NUM_PALAVRA})\\s+(dia|dias|hora|horas|semana|semanas|mes|meses)\\b`),
  );
  if (comPrefixo) return comPrefixo[0].replace(/^(ha|faz|desde)\s+/, '');
  const solta = n.match(
    new RegExp(`\\b(${NUM_PALAVRA})\\s+(dia|dias|hora|horas|semana|semanas)\\b(?!\\s+atras)`),
  );
  if (solta) return solta[0];
  if (/\banteontem\b/.test(n)) return '2 dias';
  if (/\bontem\b/.test(n)) return '1 dia';
  if (/\bhoje\b|\bagora ha pouco\b|\bhoje cedo\b/.test(n)) return 'horas';
  return 'nao_informado';
}

const RE_PERGUNTA_DEFINICAO =
  /\bo?\s*q(?:ue)?\s*(?:eh|e|sao)\b|\bpra\s*que\s*serve\b|\bpara\s*que\s*serve\b|\bquando\s*(?:ir|devo\s*ir|procurar)\b|\bcomo\s*funciona\b|\bquer\s*dizer\b|\bsignifica\b|\bdif[a-z]{3,}\b/;
const MARCADORES_PRIMEIRA_PESSOA =
  /\b(eu|estou|to|tou|tenho|sinto|senti|minha|meu|comigo|nosso|nossa|acho que|sera que|pode ser|isso e|isto e|to com|tô com)\b/;

function pareceDuvidaSobreTermo(n: string): boolean {
  return RE_PERGUNTA_DEFINICAO.test(n) && !MARCADORES_PRIMEIRA_PESSOA.test(n);
}

const RE_INTOXICACAO =
  /intoxica[cç][aã]o|envenenamento|overdose|tomei\s+\d+\s+(caixas?|cartelas?|vidros?|garrafas?|frascos?|comprimidos?|unidades?)|bebi\s+\d+\s+(vidros?|garrafas?|frascos?)|ingeri\s+\d+/;

export function extrairInformacoes(texto: string): RelatoEstruturado {
  const n = normalizarTexto(texto);
  const nc = texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s,;.!?]/gu, ' ')
    .replace(/[ \t]+/g, ' ').trim();
  const sintomas: string[] = [];
  const sinais: string[] = [];

  const palavras = n.split(/\s+/).filter((p) => p.length > 2);
  const ehSaudacao =
    palavras.length <= 3 &&
    /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|obrigado|valeu|blz|show|legal|sim|nao|ok|nada|nenhum)$/i.test(n);

  if (ehSaudacao) return { ...RELATO_VAZIO, informacao_insuficiente: true };
  if (pareceDuvidaSobreTermo(n)) return { ...RELATO_VAZIO, informacao_insuficiente: true };

  const falta_de_ar = afirmadoTri(nc, /\bfalta de ar\b|\bnao consigo respirar\b|\bdificuldade (para|de) respirar\b|\bnao respira bem\b/);
  const dor_no_peito = afirmadoTri(nc, /\bdor (no|do) peito\b|\baperto no peito\b|\bpressao no peito\b/);
  const desmaio = afirmadoTri(nc, /\bdesmaio\b|\bdesmaiei\b|\bapaguei\b|\bapagou\b|\binconsciente\b/);
  const confusao = afirmadoTri(nc, /\bconfus[aã]o\b|\bconfuso\b|\bdesorientad/);
  const sangramento = afirmadoTri(nc, /\bsangramento\b|\bsangrando\b|\bsangrou\b/);
  const febre = afirmadoTri(nc, /\bfebre\b|\bfebril\b/);
  const vomitos = afirmadoTri(nc, /\bvomito\b|\bvomitando\b|\bvomitei\b|\benjoo\b|\bnausea\b/);
  const trauma = afirmadoTri(nc, /\btrauma\b|\bacidente\b|\bbatida\b|\bqueda\b|\bcaiu\b|\bcai\b|\batropel/);
  const exposicao_intoxicacao = afirmadoTri(nc, RE_INTOXICACAO);

  const labios_roxos = afirmadoTri(nc, /\blabios (roxos|arroxeados|azuis)\b/);
  const fala_frases = extrairFalaFrases(n);
  const alergia_grave = afirmadoTri(nc, /\bgarganta (fechando|fechou)\b|\bnao consigo engolir\b|\banafilaxia\b|\balergia grave\b/);

  let autodiagnostico: string | null = null;
  for (const [re, label] of AUTODIAGNOSTICO) {
    if (afirmado(nc, re) === true) { autodiagnostico = label; break; }
  }

  const neuro = extrairNeurologicos(n);

  const temFebre = febre === true;
  const temDorCorpo = /\bdor (no |na )?(corpo|muscular|nas costas|atras dos olhos|nos olhos)\b|\bcorpo doendo\b|\bcarne tremendo\b/.test(n);
  const temMancha = /mancha[s]? (vermelha|na pele|no corpo)|exantema|pontinhos vermelhos/.test(n);
  const temDengueMencao = /\bdengue\b/.test(n);
  if ((temFebre && temDorCorpo) || (temFebre && temMancha) || temDengueMencao) {
    if (!sintomas.includes('suspeita de dengue')) sintomas.push('suspeita de dengue');
  }

  let violencia: 'domestica' | 'sexual' | null = null;
  if (/\b(me bateu|me agrediu|me empurrou|me machucou|violencia domestica|meu marido me|meu companheiro me|apanhei do|apanhei de)\b/.test(n)) {
    violencia = 'domestica';
  }
  if (/\b(estupr|abuso sexual|abusada|abusado|violencia sexual|me forcou)\b/.test(n)) {
    violencia = 'sexual';
  }

  if (/\bdor de dente\b|\bdente doendo\b|\bdente quebrado\b|\bdente inflamado\b|\babscesso dental\b/.test(n)) {
    if (!sintomas.includes('dor de dente')) sintomas.push('dor de dente');
  }

  if (/\bboca seca\b|\bolhos fundos\b|\bmoleira funda\b|\bsem urinar\b|\bnao faz xixi\b|\bnao esta urinando\b|\bchora sem lagrima\b/.test(n)) {
    if (!sintomas.includes('sinais de desidratação')) sintomas.push('sinais de desidratação');
  }

  let risco_mental: RelatoEstruturado['risco_mental'] = 'nao_mencionado';
  if (/\bquero me matar\b|\bvou me matar\b|\bn[aã]o quero mais viver\b|\bquero morrer\b|\bacabar com tudo\b|\btentativa de suic[ií]dio\b|\bme machucar\b/.test(n)) {
    risco_mental = 'iminente';
  } else if (contemAlgum(n, ['ansiedade', 'panico', 'depressao', 'crise de choro', 'insonia'])) {
    risco_mental = 'sem_risco_imediato';
  }

  let gestante: RelatoEstruturado['gestante'] = 'nao_informado';
  const gest = afirmado(nc, /\bgravida\b|\bgestante\b/);
  if (gest === true) gestante = 'sim';
  else if (gest === false) gestante = 'nao';

  const posParto: RelatoEstruturado['pos_parto'] = contemAlgum(n, ['pos parto', 'depois do parto', 'puerperio', 'tive bebe recentemente'])
    ? 'sim' : 'nao_informado';

  const obstetricos = extrairSinaisObstetricos(n, gestante, posParto);
  const traumaSinais = extrairSinaisTrauma(n);
  if (obstetricos.length) sinais.push(...obstetricos);
  if (traumaSinais.length) sinais.push(...traumaSinais);
  if (neuro.length) sinais.push('sinais_neurologicos_subitos');
  if (autodiagnostico) sinais.push(`autodiagnostico_${autodiagnostico}`);
  if (labios_roxos === true) sinais.push('labios_roxos');
  if (alergia_grave === true) sinais.push('anafilaxia');
  if (violencia === 'domestica') sinais.push('violencia_domestica');
  if (violencia === 'sexual') sinais.push('violencia_sexual');
  if (/falta de ar|respirar|labios roxos/.test(n)) sinais.push('falta_de_ar');
  if (/desmaio|apagou|inconsciente|desmaiei/.test(n)) sinais.push('alteração da consciência');
  if (/confus[aã]o|desorientad/.test(n)) sinais.push('alteração da consciência');
  if (/trauma|acidente|batida|queda de altura|atropel/.test(n)) sinais.push('trauma');
  if (/convuls[aã]o/.test(n)) sinais.push('convulsao');
  if (/sangramento intenso|hemorragia|muito sangue/.test(n)) sinais.push('sangramento_intenso');
  if (/dor no peito|aperto no peito|press[aã]o no peito/.test(n)) {
    if (falta_de_ar === true || desmaio === true || confusao === true || /suor frio/.test(n)) {
      sinais.push('dor_toracica_com_sinais_associados');
    }
  }

  const sintomasMap: [RegExp, string][] = [
    [/\bfebre\b/, 'febre'],
    [/\btosse\b/, 'tosse'],
    [/queimadura|queimei|queimou|queimar/, 'queimadura'],
    [/\bqueda\b|\bcaiu\b|\bcai\b/, 'queda'],
    [/vomito|vomitando|vomitei|enjoo|nausea/, 'vômitos'],
    [/sangramento|sangrando/, 'sangramento'],
    [/falta de ar|dificuldade (para|de) respirar/, 'falta de ar'],
    [/desmaio|apaguei|apagou|inconsciente/, 'desmaio'],
    [/confus[aã]o|desorientad/, 'confusão'],
    [/ferida|corte|lacera[cç][aã]o|machucad/, 'ferida'],
    [/\bpicad[ao]s? (de|por) (cobra|aranha|escorpi[aã]o|animal)|\bescorpi[aã]o\b|\baranha\b|\bcobra\b|peconhento/, 'picada de animal peçonhento'],
    [RE_INTOXICACAO, 'intoxicação'],
    [/ansiedade|p[aâ]nico|depress[aã]o|crise de choro|insonia/, 'sofrimento psíquico'],
    [/press[aã]o alta|hipertens[aã]o/, 'pressão alta'],
    [/convuls[aã]o/, 'convulsão'],
    [/alergia|coceira|mancha|vermelhid/, 'alergia/coceira'],
    [/tontura|vertigem|zonzeira/, 'tontura'],
    [/diarreia|caganeira/, 'diarreia'],
    [/ardor|queima[cç][aã]o ao urinar|dor ao urinar|infeccao urinaria/, 'sintoma urinário'],
  ];
  for (const [re, label] of sintomasMap) {
    const r = afirmado(nc, re);
    if (r === true && !sintomas.includes(label)) sintomas.push(label);
  }

  const dor = afirmado(nc, /\bdor\b/);
  if (dor === true) {
    const m = n.match(/dor (no|na|nos|nas|de)\s+([a-z]{3,})/);
    if (m) {
      const local = `${m[1]} ${m[2]}`;
      if (!sintomas.includes(`dor ${local}`)) sintomas.push(`dor ${local}`);
    } else if (!sintomas.some((s) => s.startsWith('dor'))) {
      sintomas.push('dor');
    }
  }

  let pessoa = 'nao_informado';
  let terceiro = false;
  for (const [chave, rotulo] of Object.entries(TERCEIROS)) {
    if (
      n.includes(`minha ${chave}`) || n.includes(`meu ${chave}`) ||
      n.includes(` a ${chave} `) || n.includes(` o ${chave} `)
    ) {
      terceiro = true;
      pessoa = rotulo;
      break;
    }
  }
  if (!terceiro && contemAlgum(n, ['pessoa', 'alguem', 'homem', 'mulher']) &&
      !/\b(sou|eu sou|me chamo)\b/.test(n)) {
    terceiro = true;
    pessoa = 'terceiro';
  }

  const { grupo: idade_grupo, numerica: idade_numerica } = extrairIdade(n);
  const duracao = extrairDuracao(n);

  const piora: RelatoEstruturado['piora'] = contemAlgum(n, ['piorando', 'piorou', 'cada vez pior', 'aumentando']) ? 'sim' : 'nao_informado';
  let intensidade = 'nao_informado';
  if (contemAlgum(n, ['forte', 'intensa', 'muito forte', 'insuportavel', 'insuportável', 'horrivel'])) intensidade = 'intensa';
  else if (contemAlgum(n, ['leve', 'moderada', 'pouca'])) intensidade = 'leve';

  const soRespostaCurta = /^(sim|nao|s|n|ok|isso)$/.test(n);
  const informacao_insuficiente =
    soRespostaCurta ||
    (sintomas.length === 0 && sinais.length === 0 && !autodiagnostico && risco_mental === 'nao_mencionado');

  const bruto: RelatoEstruturado = {
    ...RELATO_VAZIO,
    relato_sobre_terceiro: terceiro,
    pessoa,
    idade_grupo,
    idade_numerica,
    sintomas: unicos(sintomas),
    sinais_alerta: unicos(sinais),
    inicio: duracao !== 'nao_informado' ? duracao : 'nao_informado',
    duracao,
    piora,
    intensidade,
    falta_de_ar,
    dor_no_peito,
    desmaio,
    confusao,
    sangramento,
    febre,
    vomitos,
    trauma,
    exposicao_intoxicacao,
    gestante,
    pos_parto: posParto,
    risco_mental,
    informacao_insuficiente,
    informacoes_contraditorias: [],
    sinais_obstetricos: unicos(obstetricos),
    sinais_trauma: unicos(traumaSinais),
    sinais_neurologicos: unicos(neuro),
    fala_frases,
    labios_roxos,
    consegue_beber: 'nao_informado',
    alergia_grave,
    autodiagnostico_grave: autodiagnostico,
    texto_original_acumulado: '',
  };

  const validado = validarRelato(bruto);
  if (!validado.ok) console.warn('⚠️ Relato fora do formato:', bruto);
  return validado.relato;
}

// ═══════════════════════════════════════════════════════════
// Sistema de IA — Groq para texto, Gemini para áudio
// ═══════════════════════════════════════════════════════════

const SYSTEM_INSTRUCTION = `Você é um médico regulador e triador do SUS (SAMU 192, UBS, UPA).
Interprete a gravidade e o contexto por trás da mensagem — gírias, erros ortográficos, relatos sobre terceiros.
Extraia apenas o que está explícito, não invente informações.

SOBRE "intencoes":
Lista com TODAS as intenções presentes na mensagem (pode ser mais de uma).

- "conhecimento": pergunta genérica sobre saúde ou sobre o SUS.
  Ex: "o que é dengue", "qual a temperatura de febre", "como funciona o CAPS".
- "navegacao": pede indicação de onde ir / qual serviço procurar.
  Ex: "para onde vou com dor de cabeça", "onde devo ir", "aonde levo meu filho".
- "relato": descreve sintoma próprio em 1ª pessoa.
  Ex: "estou com febre há 2 dias", "sinto dor de cabeça".
- "saudacao": cumprimento isolado.
- "agradecimento": agradece/encerra.
- "outro": nada das categorias acima.

REGRA DE MULTI-INTENT (importante):
- Se a mensagem contém PERGUNTA GENÉRICA **e** RELATO/SINTOMA, devolva as duas:
  Ex: "estou com dor de cabeça, o que é dengue?" → ["relato", "conhecimento"]
  Ex: "febre e tosse. como funciona o CAPS?" → ["relato", "conhecimento"]
  Ex: "tô com dor no peito. qual UPA mais perto?" → ["relato", "navegacao"]
- Se for só cumprimento, ["saudacao"].
- Se for só agradecimento, ["agradecimento"].
- Se for só pergunta, ["conhecimento"].
- Se for só relato, ["relato"].

SOBRE "pergunta":
- Quando houver intenção "conhecimento", extraia a PERGUNTA ESPECÍFICA aqui.
- Ex: "estou com febre, o que é dengue?" → pergunta: "o que é dengue"
- Ex: "qual a temperatura de febre?" → pergunta: "qual a temperatura de febre?"
- Se não houver intenção "conhecimento", deixe string vazia.

SOBRE "sintomas":
- É a lista mais importante. Inclua QUALQUER queixa, sensação ou desconforto relatado.
- Em dúvida, INCLUA.

SOBRE "sinais_alerta":
- Só marque o que indica gravidade: falta de ar, dor no peito, desmaio, confusão, sangramento intenso, convulsão, sinais de AVC, rigidez de nuca, lábios arroxeados, dor abdominal intensa.

DIRETRIZES:
- NÃO diagnostique doenças.
- Se a mensagem NÃO tem sintoma algum e é só pergunta, deixe "informacao_insuficiente": true.`;

// ─── [Task 3] Schema com `intencoes` (array) + `pergunta` ───
export const RELATO_JSON_SCHEMA: JsonSchema = {
  name: 'relato_clinico_sus',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      intencoes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['conhecimento', 'navegacao', 'relato', 'saudacao', 'agradecimento', 'outro'],
        },
        description: 'Lista de intenções presentes na mensagem (pode ter mais de uma).',
      },
      pergunta: {
        type: 'string',
        description: 'Pergunta específica de conhecimento, se houver. Senão, string vazia.',
      },
      sintomas: { type: 'array', items: { type: 'string' } },
      sinais_alerta: { type: 'array', items: { type: 'string' } },
      relato_sobre_terceiro: { type: 'boolean' },
      pessoa: { type: 'string' },
      idade_grupo: {
        type: 'string',
        enum: ['bebe', 'crianca', 'adolescente', 'adulto', 'idoso', 'nao_informado'],
      },
      idade_numerica: { type: 'integer' },
      gestante: { type: 'string', enum: ['sim', 'nao', 'nao_informado'] },
      pos_parto: { type: 'string', enum: ['sim', 'nao', 'nao_informado'] },
      risco_mental: {
        type: 'string',
        enum: ['iminente', 'sem_risco_imediato', 'nao_mencionado'],
      },
      falta_de_ar: { type: 'boolean' },
      dor_no_peito: { type: 'boolean' },
      desmaio: { type: 'boolean' },
      confusao: { type: 'boolean' },
      sangramento: { type: 'boolean' },
      febre: { type: 'boolean' },
      vomitos: { type: 'boolean' },
      trauma: { type: 'boolean' },
      exposicao_intoxicacao: { type: 'boolean' },
      duracao: { type: 'string' },
      piora: { type: 'string', enum: ['sim', 'nao', 'nao_informado'] },
      intensidade: {
        type: 'string',
        enum: ['leve', 'moderada', 'intensa', 'nao_informado'],
      },
      informacao_insuficiente: { type: 'boolean' },
    },
    required: [
      'intencoes', 'pergunta', 'sintomas', 'sinais_alerta', 'relato_sobre_terceiro', 'pessoa',
      'idade_grupo', 'idade_numerica', 'gestante', 'pos_parto', 'risco_mental',
      'falta_de_ar', 'dor_no_peito', 'desmaio', 'confusao', 'sangramento',
      'febre', 'vomitos', 'trauma', 'exposicao_intoxicacao', 'duracao',
      'piora', 'intensidade', 'informacao_insuficiente',
    ],
    additionalProperties: false,
  },
};

function mesclarComIA(local: RelatoEstruturado, g: RelatoEstruturado): RelatoEstruturado {
  const sintomasFinal = unicos([...local.sintomas, ...g.sintomas]);
  const sinaisFinal = unicos([...local.sinais_alerta, ...g.sinais_alerta]);
  const neuroFinal = unicos([...(local.sinais_neurologicos || []), ...(g.sinais_neurologicos || [])]);
  if (neuroFinal.length > 0 && !sinaisFinal.includes('sinais_neurologicos_subitos')) {
    sinaisFinal.push('sinais_neurologicos_subitos');
  }
  const ORDEM: Record<string, number> = { nao_mencionado: 0, sem_risco_imediato: 1, iminente: 2 };

  return {
    ...local,
    sintomas: sintomasFinal,
    sinais_alerta: sinaisFinal,
    sinais_neurologicos: neuroFinal,
    gestante: local.gestante !== 'nao_informado' ? local.gestante : g.gestante,
    pos_parto: local.pos_parto !== 'nao_informado' ? local.pos_parto : g.pos_parto,
    risco_mental: ORDEM[local.risco_mental] >= ORDEM[g.risco_mental] ? local.risco_mental : g.risco_mental,
    duracao: local.duracao !== 'nao_informado' ? local.duracao : g.duracao,
    piora: local.piora !== 'nao_informado' ? local.piora : g.piora,
    intensidade: local.intensidade !== 'nao_informado' ? local.intensidade : g.intensidade,
    idade_grupo: local.idade_grupo !== 'nao_informado' ? local.idade_grupo : g.idade_grupo,
    idade_numerica: local.idade_numerica ?? g.idade_numerica ?? null,
    falta_de_ar: local.falta_de_ar !== 'nao_informado' ? local.falta_de_ar : g.falta_de_ar,
    dor_no_peito: local.dor_no_peito !== 'nao_informado' ? local.dor_no_peito : g.dor_no_peito,
    desmaio: local.desmaio !== 'nao_informado' ? local.desmaio : g.desmaio,
    confusao: local.confusao !== 'nao_informado' ? local.confusao : g.confusao,
    sangramento: local.sangramento !== 'nao_informado' ? local.sangramento : g.sangramento,
    febre: local.febre !== 'nao_informado' ? local.febre : g.febre,
    vomitos: local.vomitos !== 'nao_informado' ? local.vomitos : g.vomitos,
    trauma: local.trauma !== 'nao_informado' ? local.trauma : g.trauma,
    informacao_insuficiente: local.informacao_insuficiente && g.informacao_insuficiente,
  };
}

// ─── Texto (Groq) ───────────────────────────────────────────
export async function interpretarRelato(
  texto: string,
  historicoFormatado?: string,
): Promise<RelatoEstruturado> {
  const local = extrairInformacoes(texto);

  const prompt = `${
    historicoFormatado && historicoFormatado !== '(sem histórico)'
      ? `HISTÓRICO RECENTE DA CONVERSA:\n${historicoFormatado}\n\n---\n\n`
      : ''
  }MENSAGEM ATUAL DO USUÁRIO:
"${texto.replace(/"/g, '\\"')}"

Extraia os dados clínicos E a(s) intenção(ões) da mensagem atual. Use o histórico
somente para desambiguar referências ("e se for 40 graus?" → sobre a febre mencionada).
NÃO misture sintomas antigos com o relato atual.`;

  const parsed = await gerarJSON<any>(prompt, SYSTEM_INSTRUCTION, 20000, RELATO_JSON_SCHEMA);
  if (!parsed) return local;

  const idadeLimpa = parsed.idade_numerica === 0 ? null : parsed.idade_numerica ?? null;

  const g = validarRelato({
    ...parsed,
    idade_numerica: idadeLimpa,
    texto_original_acumulado: '',
  }).relato;

  const resultado = mesclarComIA(local, g);
  // [Task 3] preserva intenções (array) e pergunta separada
  if (Array.isArray(parsed.intencoes)) {
    resultado.intencoes = parsed.intencoes.filter((x: any) => typeof x === 'string');
  }
  if (typeof parsed.pergunta === 'string' && parsed.pergunta.trim().length > 0) {
    resultado.pergunta = parsed.pergunta.trim();
  }
  return resultado;
}

// ─── Áudio (Gemini — mantido pra extração estruturada multimodal) ───
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intencoes: { type: Type.ARRAY, items: { type: Type.STRING } },
    pergunta: { type: Type.STRING },
    sintomas: { type: Type.ARRAY, items: { type: Type.STRING } },
    sinais_alerta: { type: Type.ARRAY, items: { type: Type.STRING } },
    relato_sobre_terceiro: { type: Type.BOOLEAN },
    pessoa: { type: Type.STRING },
    idade_grupo: { type: Type.STRING, enum: ['bebe','crianca','adolescente','adulto','idoso','nao_informado'] },
    idade_numerica: { type: Type.NUMBER },
    gestante: { type: Type.STRING, enum: ['sim','nao','nao_informado'] },
    pos_parto: { type: Type.STRING, enum: ['sim','nao','nao_informado'] },
    risco_mental: { type: Type.STRING, enum: ['iminente','sem_risco_imediato','nao_mencionado'] },
    falta_de_ar: { type: Type.BOOLEAN },
    dor_no_peito: { type: Type.BOOLEAN },
    desmaio: { type: Type.BOOLEAN },
    confusao: { type: Type.BOOLEAN },
    sangramento: { type: Type.BOOLEAN },
    febre: { type: Type.BOOLEAN },
    vomitos: { type: Type.BOOLEAN },
    trauma: { type: Type.BOOLEAN },
    exposicao_intoxicacao: { type: Type.BOOLEAN },
    duracao: { type: Type.STRING },
    piora: { type: Type.STRING, enum: ['sim','nao','nao_informado'] },
    intensidade: { type: Type.STRING, enum: ['leve','moderada','intensa','nao_informado'] },
    informacao_insuficiente: { type: Type.BOOLEAN },
    transcricao: { type: Type.STRING },
  },
  required: ['intencoes', 'sintomas', 'sinais_alerta', 'relato_sobre_terceiro'],
};

export async function interpretarAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg; codecs=opus',
): Promise<RelatoEstruturado> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ...RELATO_VAZIO };

  const mimeLimpo = mimeType.split(';')[0].trim();
  const base64Audio = audioBuffer.toString('base64');

  try {
    const ai = new GoogleGenAI({ apiKey });
    const promessa = ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: [
        { inlineData: { mimeType: mimeLimpo, data: base64Audio } },
        { text: 'Transcreva o áudio e extraia os dados clínicos estruturados. Trate como texto de paciente. NÃO diagnostique.' },
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        systemInstruction: SYSTEM_INSTRUCTION,
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout audio')), 30000));
    const response = await Promise.race([promessa, timeout]) as any;
    const parsed = JSON.parse(response.text || '{}');

    const transcricao: string = typeof parsed.transcricao === 'string' ? parsed.transcricao : '';
    const local = transcricao ? extrairInformacoes(transcricao) : { ...RELATO_VAZIO };
    const g = validarRelato({ ...parsed, texto_original_acumulado: '[áudio]' }).relato;

    const resultado = mesclarComIA(local, g);
    resultado.texto_original_acumulado = '[áudio] ' + transcricao;
    if (Array.isArray(parsed.intencoes)) {
      resultado.intencoes = parsed.intencoes.filter((x: any) => typeof x === 'string');
    }
    if (typeof parsed.pergunta === 'string' && parsed.pergunta.trim().length > 0) {
      resultado.pergunta = parsed.pergunta.trim();
    }
    return resultado;
  } catch (error) {
    console.error('❌ Gemini (áudio) falhou:', error);
    return { ...RELATO_VAZIO };
  }
}