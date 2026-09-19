import { GoogleGenAI, Type } from '@google/genai';
import { contemAlgum, normalizarTexto, unicos } from './normalizar';
import { RELATO_VAZIO, type RelatoEstruturado } from './tipos';
import { validarRelato } from './validador_de_saida';

const TERCEIROS: Record<string, string> = {
  mae: 'mãe',
  pai: 'pai',
  filho: 'filho',
  filha: 'filha',
  bebe: 'bebê',
  crianca: 'criança',
  esposo: 'esposo',
  esposa: 'esposa',
  marido: 'marido',
  namorado: 'namorado',
  namorada: 'namorada',
  avo: 'avó',
  avo_masc: 'avô',
};

const REGEX_PALAVRA_CLINICA =
  /dor|febre|tosse|queimadura|queimei|queimou|queimar|queda|ca[ií]|caiu|vomito|enjoo|sangramento|falta de ar|respirar|desmaio|apagou|confus|desorientad|ferida|corte|lacera|picada|escorpi|aranha|cobra|intoxica|envenen|ansiedade|panico|depressao|caps|pressao|hipertensao|convuls|infarto|avc|trauma|batida|alergia|coceira|mancha|vermelhid|inflama|doendo|dolor|tontura|desmaiei|inchaco|inchaço|falta de|sangra|ardor|queimacao|queimação/i;

function extrairSinaisObstetricos(n: string): string[] {
  const sinais: string[] = [];
  if (/(contra[cç][oõ]es?|contraindo|dor de parto)/i.test(n)) sinais.push('contracoes');
  if (/(bolsa estourou|perda de l[ií]quido|rompeu a bolsa|saiu [aá]gua|l[ií]quido amniotico)/i.test(n))
    sinais.push('perda_liquido_amniotico');
  if (/(press[aã]o alta|hipertens[aã]o|press[aã]o [1-2][0-9]{2})/i.test(n)) sinais.push('pressao_alta');
  if (sinais.includes('pressao_alta') && /dor de cabe[cç]a intensa|enxaqueca|cefaleia intensa/i.test(n))
    sinais.push('pre_eclampsia');
  if (/sangramento vaginal|perda de sangue|hemorragia obst[eé]trica/i.test(n))
    sinais.push('sangramento_obstetrico');
  return sinais;
}

function extrairSinaisTrauma(n: string): string[] {
  const sinais: string[] = [];
  if (/(atropelamento|atropelado|acidente de tr[aâ]nsito|colis[aã]o|capotamento|carro|moto)/i.test(n))
    sinais.push('trauma_automobilistico');
  if (/(queda de altura|queda de [1-9] metros|caiu de [1-9] andar|precipita[cç][aã]o)/i.test(n))
    sinais.push('queda_altura');
  if (/(ferimento por arma|faca|tiro|perfura[cç][aã]o|esfaqueado)/i.test(n))
    sinais.push('ferimento_perfurante');
  if (/(trauma craniano|batida na cabe[cç]a|concuss[aã]o|pancada na cabe[cç]a)/i.test(n))
    sinais.push('trauma_craniano');
  return sinais;
}

export function extrairInformacoes(texto: string): RelatoEstruturado {
  const n = normalizarTexto(texto);
  const sintomas: string[] = [];
  const sinais: string[] = [];

  // ========== NEGAÇÕES EXPLÍCITAS ==========
  let forcarGestante: 'sim' | 'nao' | 'nao_informado' = 'nao_informado';
  if (contemAlgum(n, ['nao estou gravida', 'nao estou gestante', 'nao gravida', 'nao gestante'])) {
    forcarGestante = 'nao';
  }
  let forcarFebre: boolean | 'nao_informado' = 'nao_informado';
  if (contemAlgum(n, ['nao estou com febre', 'sem febre', 'nao tenho febre'])) {
    forcarFebre = false;
  }
  let negarDor = false;
  if (contemAlgum(n, ['sem dor', 'dor passou', 'nao estou com dor', 'nao tenho dor'])) {
    negarDor = true;
  }

  const temPalavraClinica = REGEX_PALAVRA_CLINICA.test(n);

  const palavras = n.split(/\s+/).filter((p) => p.length > 2);
  const ehSaudacao =
    palavras.length <= 3 &&
    /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|obrigado|valeu|blz|show|legal|sim|nao|ok|nada|nenhum)\s*$/i.test(n);

  if (ehSaudacao && !temPalavraClinica) {
    return { ...RELATO_VAZIO, informacao_insuficiente: true };
  }

  if (!temPalavraClinica && palavras.length > 3) {
    sintomas.push('queixa inespecífica');
  }

  // ========== DOR LOCALIZADA ==========
  if (!negarDor) {
    const matchDor = n.match(
      /dor no (s?[a-záéíóúâêôãõçà]+)|dor na (s?[a-záéíóúâêôãõçà]+)|dor nos (s?[a-záéíóúâêôãõçà]+)|dor nas (s?[a-záéíóúâêôãõçà]+)|dor de ([a-záéíóúâêôãõçà]+)/,
    );
    if (matchDor) {
      const local = matchDor[1] || matchDor[2] || matchDor[3] || matchDor[4] || matchDor[5] || 'parte do corpo';
      sintomas.push(`dor no ${local}`);
    } else if (/\bdor\b/.test(n)) {
      sintomas.push('dor');
    }
  }

  // ========== SINTOMAS COMUNS ==========
  const sintomasMap: [RegExp, string][] = [
    [/\bfebre\b/, 'febre'],
    [/\btosse\b/, 'tosse'],
    [/queimadura|queimei|queimou|queimar/, 'queimadura'],
    [/\bqueda\b|\bcaiu\b|\bca[ií]\b/, 'queda'],
    [/vomito|vomitando|enjoo|nausea|náusea/, 'vômitos'],
    [/sangramento|sangrando|sangra\b/, 'sangramento'],
    [/falta de ar|respirar/, 'falta de ar'],
    [/desmaio|apagou|desmaiei/, 'desmaio'],
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
    [/ardor|queima[cç][aã]o|disuria|disúria|urinar/, 'sintoma urinário'],
  ];

  for (const [regex, label] of sintomasMap) {
    if (regex.test(n) && !sintomas.includes(label)) sintomas.push(label);
  }

  if (sintomas.length === 0 && palavras.length > 2 && !ehSaudacao) {
    sintomas.push('queixa inespecífica');
  }

  // ========== SINAIS DE ALERTA ==========
  if (/falta de ar|respirar|l[aá]bios roxos/.test(n)) sinais.push('falta_de_ar');
  if (/desmaio|apagou|inconsciente|desmaiei/.test(n)) sinais.push('alteração da consciência');
  if (/confus[aã]o|desorientad/.test(n)) sinais.push('alteração da consciência');
  if (/trauma|acidente|batida|queda de altura|atropel/.test(n)) sinais.push('trauma');
  if (/convuls[aã]o/.test(n)) sinais.push('convulsao');
  if (/sangramento intenso|hemorragia|muito sangue/.test(n)) sinais.push('sangramento_intenso');

  if (/dor no peito|aperto no peito|press[aã]o no peito/.test(n)) {
    const faltaDeAr = /falta de ar|respirar/.test(n);
    const desmaio = /desmaio|apagou/.test(n);
    const confusao = /confus[aã]o/.test(n);
    const suorFrio = /suor frio/.test(n);
    if (faltaDeAr || desmaio || confusao || suorFrio) {
      sinais.push('dor_toracica_com_sinais_associados');
    }
  }

  const sinaisObstetricos = extrairSinaisObstetricos(n);
  const sinaisTrauma = extrairSinaisTrauma(n);
  if (sinaisObstetricos.length) sinais.push(...sinaisObstetricos);
  if (sinaisTrauma.length) sinais.push(...sinaisTrauma);

  // ========== TERCEIROS ==========
  let pessoa = 'nao_informado';
  let terceiro = false;
  for (const [chave, rotulo] of Object.entries(TERCEIROS)) {
    if (n.includes(`minha ${chave}`) || n.includes(`meu ${chave}`) || n.includes(` a ${chave} `) || n.includes(` o ${chave} `)) {
      terceiro = true;
      pessoa = rotulo;
      break;
    }
  }
  if (!terceiro && contemAlgum(n, ['pessoa', 'alguem', 'homem', 'mulher', 'senhor', 'senhora'])) {
    terceiro = true;
    pessoa = 'terceiro';
  }

  // ========== IDADE ==========
  let idade: RelatoEstruturado['idade_grupo'] = 'nao_informado';
  if (contemAlgum(n, ['bebe', 'recem nascido', 'meses de vida'])) idade = 'bebe';
  else if (contemAlgum(n, ['crianca', 'meu filho', 'minha filha', 'menino', 'menina'])) idade = 'crianca';
  else if (contemAlgum(n, ['adolescente'])) idade = 'adolescente';
  else if (contemAlgum(n, ['idoso', 'senhor', 'senhora', 'velhinho'])) idade = 'idoso';
  else if (contemAlgum(n, ['adulto'])) idade = 'adulto';

  // ========== DURAÇÃO ==========
  const duracaoMatch = n.match(
    /ha\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(dia|dias|hora|horas|semana|semanas|mes|meses)/,
  );
  const duracao = duracaoMatch ? duracaoMatch[0].replace('ha ', '') : 'nao_informado';

  // ========== GESTANTE ==========
  let gestante: 'sim' | 'nao' | 'nao_informado' = 'nao_informado';
  if (forcarGestante === 'nao') gestante = 'nao';
  else if (contemAlgum(n, ['gravida', 'gestante', 'gravidez'])) gestante = 'sim';

  const posParto = contemAlgum(n, ['pos parto', 'depois do parto', 'puerperio', 'tive bebe recentemente'])
    ? 'sim'
    : 'nao_informado';

  // ========== RISCO MENTAL ==========
  let riscoMental: RelatoEstruturado['risco_mental'] = 'nao_mencionado';
  if (/quero me matar|vou me matar|tentativa de suicidio|risco de se machucar agora|me machucar/.test(n)) {
    riscoMental = 'iminente';
  } else if (contemAlgum(n, ['ansiedade', 'panico', 'depressao', 'crise de choro', 'insonia', 'caps'])) {
    riscoMental = 'sem_risco_imediato';
  }

  // ========== PIORA / INTENSIDADE ==========
  const piora = contemAlgum(n, ['piorando', 'piorou', 'cada vez pior', 'aumentando']) ? 'sim' : 'nao_informado';
  let intensidade = 'nao_informado';
  if (contemAlgum(n, ['forte', 'intensa', 'muito forte', 'insuportavel', 'insuportável', 'horrivel'])) intensidade = 'intensa';
  else if (contemAlgum(n, ['leve', 'moderada', 'pouca'])) intensidade = 'leve';

  // ========== INFORMAÇÃO INSUFICIENTE ==========
  const temConteudoClinico = sintomas.length > 0 || sinais.length > 0 || temPalavraClinica;
  const informacaoInsuficiente =
    !temConteudoClinico ||
    (sintomas.length === 1 && sintomas[0] === 'queixa inespecífica' && palavras.length < 4);

  const bruto: RelatoEstruturado = {
    ...RELATO_VAZIO,
    relato_sobre_terceiro: terceiro,
    pessoa,
    idade_grupo: idade,
    sintomas: unicos(sintomas),
    sinais_alerta: unicos(sinais),
    inicio: duracao !== 'nao_informado' ? duracao : 'nao_informado',
    duracao,
    piora,
    intensidade,
    falta_de_ar: /falta de ar|respirar/.test(n) ? true : 'nao_informado',
    dor_no_peito: /dor no peito|aperto no peito|press[aã]o no peito/.test(n) ? true : 'nao_informado',
    desmaio: /desmaio|apagou|inconsciente/.test(n) ? true : 'nao_informado',
    confusao: /confus[aã]o|desorientad/.test(n) ? true : 'nao_informado',
    sangramento: /sangramento|sangrando/.test(n) ? true : 'nao_informado',
    febre: forcarFebre !== 'nao_informado' ? forcarFebre : /febre/.test(n) ? true : 'nao_informado',
    vomitos: /vomito|vomitando|enjoo|nausea/.test(n) ? true : 'nao_informado',
    trauma: /trauma|acidente|batida|queda|atropel/.test(n) ? true : 'nao_informado',
    exposicao_intoxicacao: /intoxica[cç][aã]o|envenenamento/.test(n) ? true : 'nao_informado',
    gestante,
    pos_parto: posParto,
    risco_mental: riscoMental,
    informacao_insuficiente: informacaoInsuficiente,
    informacoes_contraditorias: [],
    sinais_obstetricos: unicos(sinaisObstetricos),
    sinais_trauma: unicos(sinaisTrauma),
  };

  const validado = validarRelato(bruto);
  if (!validado.ok) console.warn('⚠️ Relato fora do formato esperado:', bruto);
  return validado.relato;
}

export async function interpretarRelato(texto: string): Promise<RelatoEstruturado> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ GEMINI_API_KEY não encontrada. Usando extrator local.');
    return extrairInformacoes(texto);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Interprete este relato de saúde recebido pelo WhatsApp e extraia os dados clínicos estruturados: "${texto}"`,
      config: {
        responseMimeType: 'application/json',
        systemInstruction: `Você é um médico regulador e triador do SUS (SAMU 192, UBS, UPA).
Sua missão é interpretar a gravidade e o contexto por trás de mensagens com gírias, erros ortográficos ou relatos sobre terceiros.
Extraia apenas o que está explícito, não invente informações.

DIRETRIZES:
- Identifique sintomas (ex: dor, febre, tosse, queimadura, queda).
- Sinalize emergências: falta de ar intensa, dor no peito com sinais, desmaio, confusão, sangramento intenso, trauma grave.
- Marque se o relato é sobre terceiro (pessoa) e identifique a pessoa (mãe, pai, filho, etc.).
- Não diagnostique doenças.`,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            sintomas: { type: Type.ARRAY, items: { type: Type.STRING } },
            sinais_alerta: { type: Type.ARRAY, items: { type: Type.STRING } },
            relato_sobre_terceiro: { type: Type.BOOLEAN },
            pessoa: { type: Type.STRING },
            desmaio: { type: Type.BOOLEAN },
            trauma: { type: Type.BOOLEAN },
            falta_de_ar: { type: Type.BOOLEAN },
            dor_no_peito: { type: Type.BOOLEAN },
            febre: { type: Type.BOOLEAN },
            confusao: { type: Type.BOOLEAN },
            sangramento: { type: Type.BOOLEAN },
            vomitos: { type: Type.BOOLEAN },
            gestante: { type: Type.STRING, enum: ['sim', 'nao', 'nao_informado'] },
            idade_grupo: { type: Type.STRING, enum: ['bebe', 'crianca', 'adolescente', 'adulto', 'idoso', 'nao_informado'] },
            intensidade: { type: Type.STRING, enum: ['leve', 'moderada', 'intensa', 'nao_informado'] },
            informacao_insuficiente: { type: Type.BOOLEAN },
          },
          required: ['sintomas', 'sinais_alerta', 'informacao_insuficiente', 'relato_sobre_terceiro'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');

    const n = normalizarTexto(texto);
    const sinaisObstetricos = extrairSinaisObstetricos(n);
    const sinaisTrauma = extrairSinaisTrauma(n);

    const alertas = [
      ...(parsed.sinais_alerta || []),
      ...(parsed.desmaio ? ['alteração da consciência'] : []),
      ...(parsed.trauma ? ['trauma'] : []),
      ...sinaisObstetricos,
      ...sinaisTrauma,
    ];

    const dadosEstruturados: RelatoEstruturado = {
      ...RELATO_VAZIO,
      relato_sobre_terceiro: parsed.relato_sobre_terceiro ?? false,
      pessoa: parsed.pessoa || (parsed.relato_sobre_terceiro ? 'terceiro' : 'paciente'),
      sintomas: unicos(parsed.sintomas || []),
      sinais_alerta: unicos(alertas),
      falta_de_ar: parsed.falta_de_ar ? true : 'nao_informado',
      dor_no_peito: parsed.dor_no_peito ? true : 'nao_informado',
      febre: parsed.febre ? true : 'nao_informado',
      desmaio: parsed.desmaio ? true : 'nao_informado',
      confusao: parsed.confusao ? true : 'nao_informado',
      sangramento: parsed.sangramento ? true : 'nao_informado',
      vomitos: parsed.vomitos ? true : 'nao_informado',
      trauma: parsed.trauma ? true : 'nao_informado',
      gestante: parsed.gestante || 'nao_informado',
      idade_grupo: parsed.idade_grupo || 'nao_informado',
      intensidade: parsed.intensidade || 'nao_informado',
      informacao_insuficiente: parsed.informacao_insuficiente ?? false,
      sinais_obstetricos: unicos(sinaisObstetricos),
      sinais_trauma: unicos(sinaisTrauma),
    };

    const validado = validarRelato(dadosEstruturados);
    if (!validado.ok) console.warn('⚠️ Relato IA fora do formato:', dadosEstruturados);
    return validado.relato;
  } catch (error) {
    console.error('❌ Gemini falhou, usando fallback determinístico:', error);
    return extrairInformacoes(texto);
  }
}