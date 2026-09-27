import { contemAlgum, normalizarTexto, unicos, afirmado, afirmadoTri } from './normalizar.js';
import { RELATO_VAZIO, type RelatoEstruturado } from './tipos.js';
import { validarRelato } from './validador_de_saida.js';

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
  if (/trauma craniano|batida na cabe[cç]a|pancada na cabe[cç]a|bateu a cabe[cç]a|bati a cabe[cç]a|bati minha cabe[cç]a|corte na cabe[cç]a|sangrando na cabe[cç]a/.test(n))
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

export function pareceDuvidaSobreTermo(n: string): boolean {
  return RE_PERGUNTA_DEFINICAO.test(n) && !MARCADORES_PRIMEIRA_PESSOA.test(n);
}

const RE_INTOXICACAO =
  /intoxica[cç][aã]o|envenenamento|overdose|tomei\s+\d+\s+(caixas?|cartelas?|vidros?|garrafas?|frascos?|comprimidos?|unidades?)|bebi\s+\d+\s+(vidros?|garrafas?|frascos?)|ingeri\s+\d+/;

export function extrairInformacoes(texto: string): RelatoEstruturado {
  const n = normalizarTexto(texto);
  const nc = texto
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
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

  // ─── Detecções críticas — reforçadas com muitos sinônimos ───

  const falta_de_ar = afirmadoTri(nc,
    /\bfalta de ar\b|\bfalta de respirar\b|\bnao consigo respirar\b|\bnao (estou )?consigo respirar\b|\bnao to conseguindo respirar\b|\bnao tou conseguindo respirar\b|\bdificuldade (para|pra|de|em) respirar\b|\bnao respira bem\b|\bsem ar\b|\bsufocando\b|\bsufocado\b|\bnao entra ar\b|\bnao ta entrando ar\b|\brespiracao curta\b|\bcansaco (para|pra) respirar\b|\bpeito fechando\b|\bgarganta fechando\b|\bestou ofegante\b|\bfalta de oxigenio\b/);

  const dor_no_peito = afirmadoTri(nc,
    /\bdor (no|do|de)?\s*peito\b|\bdor toracica\b|\baperto (no|do)\s*peito\b|\bpeito apertado\b|\bpressao (no|do)\s*peito\b|\bpeso (no|do)\s*peito\b|\bpeito doendo\b|\bta doendo o peito\b|\besta doendo o peito\b|\bdor (no|do)\s*coracao\b|\bcoracao apertado\b|\bpontada (no|do)\s*peito\b|\bpeito (ta )?apertando\b|\bsinto (um )?aperto no peito\b|\bsinto (uma )?pressao no peito\b|\bsinto (um )?peso no peito\b|\bqueimacao no peito\b/);

  const desmaio = afirmadoTri(nc,
    /\bdesmaio\b|\bdesmaiei\b|\bdesmaiou\b|\bdesmaiando\b|\bapaguei\b|\bapagou\b|\bapagando\b|\binconsciente\b|\bperdi a consciencia\b|\bperdeu a consciencia\b|\bcaiu duro\b|\bcaiu desmaiad\b|\bdeu um branco e caiu\b|\bpassou mal e caiu\b|\bperdi os sentidos\b|\bperdeu os sentidos\b/);

  const confusao = afirmadoTri(nc,
    /\bconfus[aã]o\b|\bconfuso\b|\bconfusa\b|\bdesorientad[oa]\b|\bnao sabe onde esta\b|\bnao reconhece\b|\bdelirando\b|\bdelirio\b|\bfalando coisas sem sentido\b|\bmuito sonolent[oa]\b|\bnao acorda direito\b/);

  const sangramento = afirmadoTri(nc,
    /\bsangramento\b|\bsangrando\b|\bsangrou\b|\bsangue no vomito\b|\bvomito com sangue\b|\bvomitando sangue\b|\bvomitei sangue\b|\bsangue nas fezes\b|\bfezes com sangue\b|\bfezes pretas\b|\bfezes escuras\b|\bsangue na urina\b|\bsangue no xixi\b|\bhemorragia\b|\bsangramento que nao para\b|\bnao para de sangrar\b|\bmuito sangue\b|\bsangramento intenso\b/);

  const febre = afirmadoTri(nc,
    /\bfebre\b|\bfebril\b|\bestou quente\b|\bto quente\b|\btou quente\b|\btemperatura alta\b|\btemperatura elevada\b|\besta com temperatura\b|\bta com temperatura\b|\b38 graus\b|\b39 graus\b|\b40 graus\b|\b38,5\b|\b39,5\b|\b40,5\b|\bquebrado de febre\b/);

  const vomitos = afirmadoTri(nc,
    /\bvomito\b|\bvomitando\b|\bvomitei\b|\bvomitar\b|\benjoo\b|\benjoando\b|\bnausea\b|\bnausead[oa]\b|\bmal estar no estomago\b|\bmareo\b|\bmaread[oa]\b|\bemese\b/);

  const trauma = afirmadoTri(nc,
    /\btrauma\b|\bacidente\b|\bbatida\b|\bcolisao\b|\bcolidiu\b|\bcapotamento\b|\bcapotou\b|\bqueda\b|\bcaiu\b|\bcai\b|\bdespencou\b|\batropel\b|\batropelamento\b|\bchoque\b|\bbateu a cabeca\b|\bpancada\b|\blevou pancada\b|\blevou uma queda\b/);

  const exposicao_intoxicacao = afirmadoTri(nc,
    /intoxica[cç][aã]o|envenenamento|overdose|tomei\s+\d+\s+(caixas?|cartelas?|vidros?|garrafas?|frascos?|comprimidos?|unidades?)|bebi\s+\d+\s+(vidros?|garrafas?|frascos?)|ingeri\s+\d+|tomei (muito|varios|bastante)|exagerei na dose|tomei (a )?cartela (toda|inteira)|engoli (muito|varios|bastante)/);

  const labios_roxos = afirmadoTri(nc,
    /\blabios (roxos|arroxeados|azuis)\b|\blabio (roxo|arroxeado|azul)\b|\bboca (roxa|arroxeada|azul)\b|\bpele (roxa|arroxeada|azulada)\b|\bficou rox[oa]\b|\besta ficando rox[oa]\b|\bc[oó]rculo azul nos labios\b/);

  const fala_frases = extrairFalaFrases(n);

  const alergia_grave = afirmadoTri(nc,
    /\bgarganta (fechando|fechou)\b|\bnao consigo engolir\b|\banafilaxia\b|\balergia grave\b|\balergia forte\b|\breacao alergica grave\b|\binchaco (nos labios|na lingua|na garganta|no rosto)\b|\blingua inchada\b|\blabios inchados\b|\bcoceira no corpo todo\b|\bplacas na pele\b|\burticaria\b|\bchoque anafilatico\b|\bnao consigo respirar e estou com alergia\b/);

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
    [/refluxo|azia|queima[cç][aã]o no estomago|gastrite/, 'refluxo/azia'],
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
