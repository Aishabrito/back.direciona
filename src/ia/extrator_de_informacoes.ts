import dotenv from 'dotenv';
dotenv.config();

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

function marcar(flag: boolean, lista: string[], rotulo: string) {
  if (flag) lista.push(rotulo);
}

function extrairSinaisObstetricos(n: string): string[] {
  const sinais: string[] = [];
  if (/(contra[cç][oõ]es?|contraindo|dor de parto|contração)/i.test(n))
    sinais.push('contracoes');
  if (/(bolsa estourou|perda de l[ií]quido|rompeu a bolsa|saiu [aá]gua|líquido amniotico)/i.test(n))
    sinais.push('perda_liquido_amniotico');
  if (/(press[aã]o alta|hipertens[aã]o|press[aã]o [1-2][0-9]{2})/i.test(n))
    sinais.push('pressao_alta');
  if (sinais.includes('pressao_alta') && /dor de cabe[cç]a intensa|enxaqueca|cefaleia intensa/i.test(n))
    sinais.push('pre_eclampsia');
  if (/sangramento vaginal|perda de sangue|hemorragia obstétrica/i.test(n))
    sinais.push('sangramento_obstetrico');
  return sinais;
}

function extrairSinaisTrauma(n: string): string[] {
  const sinais: string[] = [];
  if (/(atropelamento|atropelado|acidente de trânsito|colisão|capotamento|carro|moto)/i.test(n))
    sinais.push('trauma_automobilistico');
  if (/(queda de altura|queda de [1-9] metros|caiu de [1-9] andar|precipitação)/i.test(n))
    sinais.push('queda_altura');
  if (/(ferimento por arma|faca|tiro|perfuração|esfaqueado)/i.test(n))
    sinais.push('ferimento_perfurante');
  if (/(trauma craniano|batida na cabeça|concussão|pancada na cabeça)/i.test(n))
    sinais.push('trauma_craniano');
  return sinais;
}

// ---- FALLBACK DETERMINÍSTICO (agora GENÉRICO) ----
export function extrairInformacoes(texto: string): RelatoEstruturado {
  const n = normalizarTexto(texto);
  const sintomas: string[] = [];
  const sinais: string[] = [];

  // ========== NEGAÇÕES EXPLÍCITAS ==========
  let forcarGestante: 'sim' | 'nao' | 'nao_informado' = 'nao_informado';
  if (contemAlgum(n, ['nao estou gravida', 'não estou grávida', 'nao estou grávida', 'nao gravida', 'nao estou gestante'])) {
    forcarGestante = 'nao';
  }
  let forcarFebre: boolean | 'nao_informado' = 'nao_informado';
  if (contemAlgum(n, ['nao estou com febre', 'não estou com febre', 'sem febre'])) {
    forcarFebre = false;
  }
  let forcarDor: boolean = false;
  if (contemAlgum(n, ['sem dor', 'dor passou', 'nao estou com dor', 'não estou com dor'])) {
    forcarDor = true;
  }

  // ---- EXTRAÇÃO GENÉRICA DE SINAIS E SINTOMAS ----
  // Detecta se há alguma palavra que indique saúde/queixa, sem listar todas
  const temPalavraClinica = /dor|febre|tosse|queimadura|queimei|queimou|queda|ca[ií]|vomito|enjoo|sangramento|falta de ar|respirar|desmaio|apagou|confusão|desorientad|ferida|corte|laceração|picada|escorpião|aranha|cobra|intoxicação|ansiedade|pânico|depressão|caps|pressão|hipertensão|convulsão|infarto|avc|trauma|batida|alergia|coceira|mancha|vermelhidão|inflamação|dor no|dor na|dor nos|dor nas|doendo|dolor/i.test(n);

  // Se for apenas saudação, não considerar como queixa
  const palavras = n.split(/\s+/).filter(p => p.length > 2);
  const ehSaudacao = palavras.length <= 3 && /oi|ola|bom dia|boa tarde|boa noite|tudo bem|obrigado|valeu|blz|show|legal|sim|nao|não|ok|nada|nenhum/i.test(n);

  if (ehSaudacao && !temPalavraClinica) {
    return {
      ...RELATO_VAZIO,
      informacao_insuficiente: true,
    };
  }

  // Se não há palavra clínica, mas o texto tem mais de 3 palavras, assume que pode ser uma queixa vaga
  if (!temPalavraClinica && palavras.length > 3) {
    sintomas.push('queixa inespecífica');
  }

  // ========== DETECÇÃO DE SINTOMAS COMUNS (regex simples) ==========
  // Não listamos todas as partes do corpo – o regex captura "dor no/na/nos/nas" seguido de qualquer palavra
  if (!forcarDor) {
    // Dor localizada
    const matchDor = n.match(/dor no (s?[a-záéíóúâêôãõç]+)|dor na (s?[a-záéíóúâêôãõç]+)|dor nos (s?[a-záéíóúâêôãõç]+)|dor nas (s?[a-záéíóúâêôãõç]+)/);
    if (matchDor) {
      const local = matchDor[1] || matchDor[2] || matchDor[3] || matchDor[4] || 'parte do corpo';
      sintomas.push(`dor no ${local}`);
    } else if (/dor/.test(n)) {
      sintomas.push('dor');
    }
  }

  // Outros sintomas comuns (apenas palavras-chave amplas)
  const sintomasMap: [RegExp, string][] = [
    [/febre/, 'febre'],
    [/tosse/, 'tosse'],
    [/queimadura|queimei|queimou|queimar/, 'queimadura'],
    [/queda|ca[ií]|caiu/, 'queda'],
    [/vomito|vomitando|enjoo/, 'vômitos'],
    [/sangramento|sangrando/, 'sangramento'],
    [/falta de ar|respirar/, 'falta de ar'],
    [/desmaio|apagou/, 'desmaio'],
    [/confus[aã]o|desorientad/, 'confusão'],
    [/ferida|corte|laceração/, 'ferida'],
    [/picada|escorpião|aranha|cobra/, 'picada de animal peçonhento'],
    [/intoxicaç[aã]o|envenenamento/, 'intoxicação'],
    [/ansiedade|pânico|depressão|caps/, 'sofrimento psíquico'],
    [/press[aã]o alta|hipertensão/, 'pressão alta'],
    [/convuls[aã]o/, 'convulsão'],
    [/alergia|coceira|mancha/, 'alergia/coceira'],
  ];

  for (const [regex, label] of sintomasMap) {
    if (regex.test(n) && !sintomas.includes(label)) {
      sintomas.push(label);
    }
  }

  // Se ainda não há sintomas e o texto não é saudação, assume queixa inespecífica
  if (sintomas.length === 0 && palavras.length > 2 && !ehSaudacao) {
    sintomas.push('queixa inespecífica');
  }

  // ---- SINAIS DE ALERTA (emergência) ----
  if (/falta de ar|respirar|labios roxos/.test(n)) sinais.push('falta_de_ar');
  if (/desmaio|apagou|inconsciente/.test(n)) sinais.push('alteração da consciência');
  if (/confus[aã]o|desorientad/.test(n)) sinais.push('alteração da consciência');
  if (/trauma|acidente|batida|queda de altura|atropel/.test(n)) sinais.push('trauma');
  if (/convuls[aã]o/.test(n)) sinais.push('convulsao');
  if (/dor no peito|aperto no peito|pressão no peito/.test(n)) {
    const faltaDeAr = /falta de ar|respirar/.test(n);
    const desmaio = /desmaio|apagou/.test(n);
    const confusao = /confus[aã]o/.test(n);
    const suorFrio = /suor frio/.test(n);
    if (faltaDeAr || desmaio || confusao || suorFrio) {
      sinais.push('dor_toracica_com_sinais_associados');
    }
  }

  // Sinais obstétricos e trauma (usando funções existentes)
  const sinaisObstetricos = extrairSinaisObstetricos(n);
  const sinaisTrauma = extrairSinaisTrauma(n);
  if (sinaisObstetricos.length) sinais.push(...sinaisObstetricos);
  if (sinaisTrauma.length) sinais.push(...sinaisTrauma);

  // ---- TERCEIROS ----
  let pessoa = 'nao_informado';
  let terceiro = false;
  for (const [chave, rotulo] of Object.entries(TERCEIROS)) {
    if (n.includes(`minha ${chave}`) || n.includes(`meu ${chave}`)) {
      terceiro = true;
      pessoa = rotulo;
      break;
    }
  }
  if (contemAlgum(n, ['pessoa', 'alguem', 'homem', 'mulher', 'senhor', 'senhora', 'crianca'])) {
    terceiro = true;
    pessoa = 'terceiro';
  }

  // ---- IDADE ----
  let idade: RelatoEstruturado['idade_grupo'] = 'nao_informado';
  if (contemAlgum(n, ['bebe', 'recem nascido', 'meses de vida'])) idade = 'bebe';
  else if (contemAlgum(n, ['crianca', 'meu filho', 'minha filha'])) idade = 'crianca';
  else if (contemAlgum(n, ['adolescente'])) idade = 'adolescente';
  else if (contemAlgum(n, ['idoso', 'senhor', 'senhora'])) idade = 'idoso';
  else if (contemAlgum(n, ['adulto'])) idade = 'adulto';

  // ---- DURAÇÃO ----
  const duracaoMatch = n.match(/ha\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(dia|dias|hora|horas|semana|semanas|mes|meses)/);
  const duracao = duracaoMatch ? duracaoMatch[0].replace('ha ', '') : 'nao_informado';

  // ---- GESTANTE (com negação) ----
  let gestante: 'sim' | 'nao' | 'nao_informado' = 'nao_informado';
  if (forcarGestante === 'nao') {
    gestante = 'nao';
  } else if (contemAlgum(n, ['gravida', 'gestante', 'estou gravida'])) {
    gestante = 'sim';
  }

  const posParto = contemAlgum(n, ['pos parto', 'depois do parto', 'tive bebe recentemente', 'puerperio']) ? 'sim' : 'nao_informado';

  // ---- RISCO MENTAL ----
  let riscoMental: RelatoEstruturado['risco_mental'] = 'nao_mencionado';
  if (/quero me matar|vou me matar|tentativa de suicidio|risco de se machucar agora/.test(n)) {
    riscoMental = 'iminente';
  } else if (contemAlgum(n, ['ansiedade', 'panico', 'depressao', 'crise de choro', 'insonia', 'caps'])) {
    riscoMental = 'sem_risco_imediato';
  }

  // ---- PIORA, INTENSIDADE ----
  const piora = contemAlgum(n, ['piorando', 'piorou', 'cada vez pior']) ? 'sim' : 'nao_informado';
  let intensidade = 'nao_informado';
  if (contemAlgum(n, ['forte', 'intensa', 'muito forte', 'insuportável'])) intensidade = 'intensa';
  else if (contemAlgum(n, ['leve', 'moderada'])) intensidade = 'leve';

  // ---- INFORMAÇÃO INSUFICIENTE ----
  const temConteudoClinico = sintomas.length > 0 || sinais.length > 0 || temPalavraClinica;
  const informacaoInsuficiente = !temConteudoClinico || (sintomas.length === 1 && sintomas[0] === 'queixa inespecífica' && palavras.length < 4);

  // ---- MONTAGEM FINAL ----
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
    dor_no_peito: /dor no peito|aperto no peito|pressão no peito/.test(n) ? true : 'nao_informado',
    desmaio: /desmaio|apagou|inconsciente/.test(n) ? true : 'nao_informado',
    confusao: /confus[aã]o|desorientad/.test(n) ? true : 'nao_informado',
    sangramento: /sangramento|sangrando/.test(n) ? true : 'nao_informado',
    febre: forcarFebre !== 'nao_informado' ? forcarFebre : (/febre/.test(n) ? true : 'nao_informado'),
    vomitos: /vomito|vomitando|enjoo/.test(n) ? true : 'nao_informado',
    trauma: /trauma|acidente|batida|queda|atropel/.test(n) ? true : 'nao_informado',
    exposicao_intoxicacao: /intoxicaç[aã]o|envenenamento/.test(n) ? true : 'nao_informado',
    gestante,
    pos_parto: posParto,
    risco_mental: riscoMental,
    informacao_insuficiente: informacaoInsuficiente,
    informacoes_contraditorias: [],
    sinais_obstetricos: unicos(sinaisObstetricos),
    sinais_trauma: unicos(sinaisTrauma),
  };

  return validarRelato(bruto).relato;
}

// ---- INTERPRETAÇÃO INTELIGENTE VIA GEMINI ----
export async function interpretarRelato(texto: string): Promise<RelatoEstruturado> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn("⚠️ GEMINI_API_KEY não encontrada no .env. Usando extrator local.");
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
    return validado.relato;
  } catch (error) {
    console.error('Falha ao processar com o Gemini, acionando fallback determinístico:', error);
    return extrairInformacoes(texto);
  }
}