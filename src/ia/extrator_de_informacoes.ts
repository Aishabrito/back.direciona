import { GoogleGenAI, Type } from '@google/genai';
import { contemAlgum, normalizarTexto, unicos, afirmado, afirmadoTri } from './normalizar';
import { RELATO_VAZIO, type RelatoEstruturado } from './tipos';
import { validarRelato } from './validador_de_saida';

const TERCEIROS: Record<string, string> = {
  mae: 'mãe', pai: 'pai', filho: 'filho', filha: 'filha',
  bebe: 'bebê', crianca: 'criança', esposo: 'esposo', esposa: 'esposa',
  marido: 'marido', namorado: 'namorado', namorada: 'namorada',
  avo: 'avó', avo_masc: 'avô', irmao: 'irmão', irma: 'irmã',
  vo: 'vô', vo_fem: 'vó',
};

const REGEX_PALAVRA_CLINICA =
  /\bdor\b|\bfebre\b|\btosse\b|queimadura|queimei|queimou|queimar|\bqueda\b|\bcaiu\b|\bcai\b|vomito|vomitando|vomitei|enjoo|nausea|\bsangramento\b|\bsangrando\b|falta de ar|respirar|\bdesmaio\b|apagou|desmaiei|confus|desorientad|ferida|corte|lacera|picada|escorpi|aranha|cobra|intoxica|envenen|ansiedade|panico|depressao|caps|pressao|hipertensao|convuls|trauma|batida|alergia|coceira|mancha|vermelhid|inflama|doendo|\bdolor\b|tontura|inchaco|inchaço|ardor|queimacao|queimação/i;

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
  if (/sangramento vaginal|sangramento|perda de sangue|hemorragia/.test(n)) sinais.push('sangramento_obstetrico');
  return sinais;
}

function extrairSinaisTrauma(n: string): string[] {
  const sinais: string[] = [];
  const temAcidente = /\b(atropel|acidente|colis[aã]o|capot|batida|bati|bateu|colidiu)\b/.test(n);
  if (temAcidente && /\b(carro|moto|autom[oó]vel|caminh[aã]o|[oô]nibus)\b/.test(n)) sinais.push('trauma_automobilistico');
  if (/\batropel/.test(n)) sinais.push('trauma_automobilistico');
  if (/queda de altura|queda de [1-9] metros|caiu de [1-9] andar/.test(n)) sinais.push('queda_altura');
  if (/arma branca|faca|esfaquead|levou (uma )?facada|arma de fogo|\btiro\b|balead|levou (um )?tiro|perfura[cç][aã]o/.test(n))
    sinais.push('ferimento_perfurante');
  if (/trauma craniano|batida na cabe[cç]a|pancada na cabe[cç]a|bateu a cabe[cç]a/.test(n))
    sinais.push('trauma_craniano');
  return sinais;
}

function extrairNeurologicos(n: string): string[] {
  const sinais: string[] = [];
  for (const [re, label] of NEUROLOGICOS) if (re.test(n)) sinais.push(label);
  return sinais;
}

function extrairIdade(n: string): { grupo: RelatoEstruturado['idade_grupo']; numerica: number | null } {
  const m = n.match(/\b(\d{1,3})\s*(anos?|meses?)\b/);
  let numerica: number | null = null;
  if (m) {
    const val = parseInt(m[1], 10);
    numerica = m[2].startsWith('mes') ? Math.max(0, Math.round(val / 12)) : val;
  }
  const bebe = contemAlgum(n, ['bebe', 'recem nascido', 'meses de vida']) || (numerica !== null && numerica < 2);
  const crianca = contemAlgum(n, ['crianca', 'meu filho', 'minha filha', 'menino', 'menina']) || (numerica !== null && numerica < 12);
  const adolescente = contemAlgum(n, ['adolescente']) || (numerica !== null && numerica < 18);
  const idoso = contemAlgum(n, ['idoso', 'senhor', 'senhora', 'velhinho']) || (numerica !== null && numerica >= 65);
  const grupo: RelatoEstruturado['idade_grupo'] =
    bebe ? 'bebe'
    : crianca ? 'crianca'
    : adolescente ? 'adolescente'
    : idoso ? 'idoso'
    : contemAlgum(n, ['adulto']) ? 'adulto'
    : 'nao_informado';
  return { grupo, numerica };
}

function extrairDuracao(n: string): string {
  const num = n.match(
    /\b(?:ha|faz|desde)\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(dia|dias|hora|horas|semana|semanas|mes|meses)\b/,
  );
  if (num) return num[0].replace(/^(ha|faz|desde)\s+/, '');
  if (/\bdesde ontem\b/.test(n)) return '1 dia';
  if (/\bhoje\b/.test(n)) return 'horas';
  return 'nao_informado';
}

export function extrairInformacoes(texto: string): RelatoEstruturado {
  const n = normalizarTexto(texto);
  const sintomas: string[] = [];
  const sinais: string[] = [];

  const palavras = n.split(/\s+/).filter((p) => p.length > 2);
  const ehSaudacao =
    palavras.length <= 3 &&
    /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|obrigado|valeu|blz|show|legal|sim|nao|ok|nada|nenhum)$/i.test(n);

  if (ehSaudacao) return { ...RELATO_VAZIO, informacao_insuficiente: true };

  // FLAGS COM NEGAÇÃO GENÉRICA
  const falta_de_ar = afirmadoTri(n, /\bfalta de ar\b|\bnao consigo respirar\b|\bdificuldade (para|de) respirar\b|\bnao respira bem\b/);
  const dor_no_peito = afirmadoTri(n, /\bdor (no|do) peito\b|\baperto no peito\b|\bpressao no peito\b/);
  const desmaio = afirmadoTri(n, /\bdesmaio\b|\bdesmaiei\b|\bapaguei\b|\bapagou\b|\binconsciente\b/);
  const confusao = afirmadoTri(n, /\bconfus[aã]o\b|\bconfuso\b|\bdesorientad/);
  const sangramento = afirmadoTri(n, /\bsangramento\b|\bsangrando\b|\bsangrou\b/);
  const febre = afirmadoTri(n, /\bfebre\b|\bfebril\b/);
  const vomitos = afirmadoTri(n, /\bvomito\b|\bvomitando\b|\bvomitei\b|\benjoo\b|\bnausea\b/);
  const trauma = afirmadoTri(n, /\btrauma\b|\bacidente\b|\bbatida\b|\bqueda\b|\bcaiu\b|\bcai\b|\batropel/);
  const exposicao_intoxicacao = afirmadoTri(n, /intoxica[cç][aã]o|envenenamento/);

  const labios_roxos = afirmadoTri(n, /\blabios (roxos|arroxeados|azuis)\b/);
  const fala_frases = afirmadoTri(n, /\bnao consigo falar\b|\bnao falo\b|\bnao consigo terminar a frase\b/);
  const alergia_grave = afirmadoTri(n, /\bgarganta (fechando|fechou)\b|\bnao consigo engolir\b|\banafilaxia\b|\balergia grave\b/);

  // AUTODIAGNÓSTICO
  let autodiagnostico: string | null = null;
  for (const [re, label] of AUTODIAGNOSTICO) {
    if (re.test(n)) { autodiagnostico = label; break; }
  }

  const neuro = extrairNeurologicos(n);

  // RISCO MENTAL
  let risco_mental: RelatoEstruturado['risco_mental'] = 'nao_mencionado';
  if (/\bquero me matar\b|\bvou me matar\b|\bn[aã]o quero mais viver\b|\bquero morrer\b|\bacabar com tudo\b|\btentativa de suic[ií]dio\b|\bme machucar\b/.test(n)) {
    risco_mental = 'iminente';
  } else if (contemAlgum(n, ['ansiedade', 'panico', 'depressao', 'crise de choro', 'insonia', 'caps'])) {
    risco_mental = 'sem_risco_imediato';
  }

  // GESTANTE / POS-PARTO
  let gestante: RelatoEstruturado['gestante'] = 'nao_informado';
  const gest = afirmado(n, /\bgravida\b|\bgestante\b/);
  if (gest === true) gestante = 'sim';
  else if (gest === false) gestante = 'nao';

  const posParto: RelatoEstruturado['pos_parto'] = contemAlgum(n, ['pos parto', 'depois do parto', 'puerperio', 'tive bebe recentemente'])
    ? 'sim' : 'nao_informado';

  // SINAIS ESPECIALIZADOS
  const obstetricos = extrairSinaisObstetricos(n, gestante, posParto);
  const traumaSinais = extrairSinaisTrauma(n);
  if (obstetricos.length) sinais.push(...obstetricos);
  if (traumaSinais.length) sinais.push(...traumaSinais);
  if (neuro.length) sinais.push('sinais_neurologicos_subitos');
  if (autodiagnostico) sinais.push(`autodiagnostico_${autodiagnostico}`);
  if (labios_roxos === true) sinais.push('labios_roxos');
  if (alergia_grave === true) sinais.push('anafilaxia');
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

  // SINTOMAS COMUNS
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
    [/picada|escorpi[aã]o|aranha|cobra|peconhento/, 'picada de animal peçonhento'],
    [/intoxica[cç][aã]o|envenenamento|ingeri/, 'intoxicação'],
    [/ansiedade|p[aâ]nico|depress[aã]o|caps|crise de choro/, 'sofrimento psíquico'],
    [/press[aã]o alta|hipertens[aã]o/, 'pressão alta'],
    [/convuls[aã]o/, 'convulsão'],
    [/alergia|coceira|mancha|vermelhid/, 'alergia/coceira'],
    [/tontura|vertigem|zonzeira/, 'tontura'],
    [/diarreia|caganeira/, 'diarreia'],
    [/ardor|queima[cç][aã]o ao urinar|dor ao urinar|infeccao urinaria/, 'sintoma urinário'],
  ];
  for (const [re, label] of sintomasMap) {
    const r = afirmado(n, re);
    if (r === true && !sintomas.includes(label)) sintomas.push(label);
  }

  const dor = afirmado(n, /\bdor\b/);
  if (dor === true) {
    const m = n.match(/dor (no|na|nos|nas|de)\s+([a-z]{3,})/);
    if (m) {
      const local = `${m[1]} ${m[2]}`;
      if (!sintomas.includes(`dor ${local}`)) sintomas.push(`dor ${local}`);
    } else if (!sintomas.some((s) => s.startsWith('dor'))) {
      sintomas.push('dor');
    }
  }

  // TERCEIROS
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
  if (!terceiro && contemAlgum(n, ['pessoa', 'alguem', 'homem', 'mulher', 'senhor', 'senhora'])
      && !/\b(sou|eu sou|me chamo)\b/.test(n)) {
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

// ============================================================
// GEMINI texto — schema completo + timeout + temperature 0 + união
// ============================================================
export async function interpretarRelato(texto: string): Promise<RelatoEstruturado> {
  const local = extrairInformacoes(texto);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GEMINI_API_KEY não encontrada. Usando extrator local.');
    return local;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const promessa = ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Relato de saúde: "${texto.replace(/"/g, '\\"')}"`,
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        systemInstruction: `Você é um médico regulador e triador do SUS (SAMU 192, UBS, UPA).
Sua missão é interpretar a gravidade e o contexto por trás de mensagens com gírias, erros ortográficos ou relatos sobre terceiros.
Extraia apenas o que está explícito, não invente informações.
DIRETRIZES:
- Identifique sintomas (ex: dor, febre, tosse, queimadura, queda).
- Sinalize emergências: falta de ar intensa, dor no peito com sinais, desmaio, confusão, sangramento intenso, trauma grave, sinais de AVC (boca torta, fala enrolada).
- Marque se o relato é sobre terceiro (pessoa) e identifique a pessoa (mãe, pai, filho, etc.).
- Não diagnostique doenças.`,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
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
          },
          required: ['sintomas', 'sinais_alerta', 'relato_sobre_terceiro'],
        },
      },
    });

    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout gemini')), 8000));
    const response = await Promise.race([promessa, timeout]) as any;
    const parsed = JSON.parse(response.text || '{}');
    const g = validarRelato({ ...parsed, texto_original_acumulado: '' }).relato;

    const sintomasFinal = unicos([...local.sintomas, ...g.sintomas]);
    const sinaisFinal = unicos([...local.sinais_alerta, ...g.sinais_alerta]);
    const neuroFinal = unicos([...(local.sinais_neurologicos || []), ...(g.sinais_neurologicos || [])]);
    if (neuroFinal.length > 0 && !sinaisFinal.includes('sinais_neurologicos_subitos')) {
      sinaisFinal.push('sinais_neurologicos_subitos');
    }

    const ORDEM_RISCO_LOCAL: Record<string, number> = { nao_mencionado: 0, sem_risco_imediato: 1, iminente: 2 };

    const merge: RelatoEstruturado = {
      ...local,
      sintomas: sintomasFinal,
      sinais_alerta: sinaisFinal,
      sinais_neurologicos: neuroFinal,
      gestante: local.gestante !== 'nao_informado' ? local.gestante : g.gestante,
      pos_parto: local.pos_parto !== 'nao_informado' ? local.pos_parto : g.pos_parto,
      risco_mental: (ORDEM_RISCO_LOCAL[local.risco_mental] >= ORDEM_RISCO_LOCAL[g.risco_mental])
        ? local.risco_mental : g.risco_mental,
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
    return merge;
  } catch (error) {
    console.error('❌ Gemini falhou/timeout, usando extrator local:', error);
    return local;
  }
}

// ============================================================
// [NOVO] ÁUDIO — interpreta DIRETO no Gemini, sem transcrição
// ============================================================
export async function interpretarAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg; codecs=opus',
): Promise<RelatoEstruturado> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GEMINI_API_KEY ausente. Não é possível interpretar áudio.');
    return { ...RELATO_VAZIO };
  }

  const mimeLimpo = mimeType.split(';')[0].trim();
  const base64Audio = audioBuffer.toString('base64');

  try {
    const ai = new GoogleGenAI({ apiKey });

    const promessa = ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: mimeLimpo,
            data: base64Audio,
          },
        },
        {
          text:
            'Ouça este relato de saúde em áudio e extraia os dados clínicos estruturados. ' +
            'Trate como se fosse uma mensagem de texto do paciente. ' +
            'Não diagnostique, não prescreva, apenas extraia o que foi dito.',
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        systemInstruction: `Você é um médico regulador e triador do SUS (SAMU 192, UBS, UPA).
Ouça o áudio e interprete a gravidade e o contexto por trás da fala — gírias, erros, relatos sobre terceiros.
Extraia apenas o que está explícito no áudio, não invente informações.
DIRETRIZES:
- Identifique sintomas (dor, febre, tosse, queimadura, queda).
- Sinalize emergências: falta de ar intensa, dor no peito com sinais, desmaio, confusão, sangramento intenso, trauma grave, sinais de AVC (boca torta, fala enrolada).
- Marque se o relato é sobre terceiro (mãe, pai, filho) e identifique a pessoa.
- Identifique ideação suicida ou autolesão ("quero morrer", "não quero mais viver").
- NÃO diagnostique doenças.`,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
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
          },
          required: ['sintomas', 'sinais_alerta', 'relato_sobre_terceiro'],
        },
      },
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout gemini audio')), 20000),
    );
    const response = (await Promise.race([promessa, timeout])) as any;
    const parsed = JSON.parse(response.text || '{}');

    const validado = validarRelato({
      ...parsed,
      texto_original_acumulado: '[áudio]',
    });

    if (!validado.ok) console.warn('⚠️ Relato do áudio fora do formato:', parsed);
    return validado.relato;
  } catch (error) {
    console.error('❌ Gemini falhou ao interpretar áudio:', error);
    return { ...RELATO_VAZIO };
  }
}