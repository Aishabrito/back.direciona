// ia/extrator_de_informacoes.ts
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

// ---- NOVAS FUNÇÕES DE EXTRAÇÃO ESPECIALIZADA ----
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
// -------------------------------------------------

export function extrairInformacoes(texto: string): RelatoEstruturado {
  const n = normalizarTexto(texto);
  const sintomas: string[] = [];
  const sinais: string[] = [];

  const faltaDeAr = contemAlgum(n, [
    'falta de ar',
    'falta dar',
    'ofegante',
    'nao consigo respirar',
    'dificuldade para respirar',
    'labios roxos',
    'lábios arroxeados',
    'nao consegue falar frases',
  ]);
  const dorPeito = contemAlgum(n, ['dor no peito', 'aperto no peito', 'pressao no peito', 'dor toracica']);
  const desmaio = contemAlgum(n, ['desmaio', 'desmaiou', 'desmaiei', 'apagou', 'nao responde', 'inconsciente']);
  const confusao = contemAlgum(n, ['confusa', 'confuso', 'desorientad', 'alteracao da consciencia', 'nao reconhece']);
  const sangramento = contemAlgum(n, ['sangramento', 'sangrando', 'sangue', 'hemorragia']);
  const febre = contemAlgum(n, ['febre', 'febril', 'quentura']);
  const vomitos = contemAlgum(n, ['vomito', 'vomitando', 'enjoo forte']);
  // TRAUMA – agora capturamos mais mecanismos
  const trauma = contemAlgum(n, [
    'caiu', 'queda', 'bateu a cabeca', 'atropel', 'acidente',
    'queda de altura', 'trauma', 'colisao', 'capotamento',
  ]);
  const intoxicacao = contemAlgum(n, ['intoxic', 'envenen', 'tomou produto', 'ingestao de']);
  const convulsao = contemAlgum(n, ['convulsao', 'convulsao', 'ataque convulsivo']);
  const avcSinais = contemAlgum(n, [
    'fala enrolada',
    'nao consegue falar',
    'boca torta',
    'rosto torto',
    'fraqueza de um lado',
    'perda de visao subita',
  ]);
  const suorFrio = contemAlgum(n, ['suor frio', 'suando frio', 'palidez']);
  const dorAbdomen = contemAlgum(n, ['dor na barriga', 'dor abdominal', 'dor no abdomen']);
  const fratura = contemAlgum(n, ['fratura', 'osso quebrado', 'osso estalou']);
  const queimadura = contemAlgum(n, ['queimadura', 'queimou']);
  const picada = contemAlgum(n, ['picada de', 'cobra', 'escorpiao', 'aranha']);
  const ferida = contemAlgum(n, ['ferida', 'corte', 'laceracao']);
  const urinarios = contemAlgum(n, ['ardor para urinar', 'dor para urinar', 'infeccao urinaria']);
  const dorCostas = contemAlgum(n, ['dor nas costas', 'dor lombar']);
  const desidratacao = contemAlgum(n, [
    'nao consigo beber',
    'nao consegue beber',
    'sem beber agua',
    'boca seca',
    'muito fraco',
    'muito fraca',
    'prostrad',
  ]);
  const sintomasLeves = contemAlgum(n, [
    'coriza',
    'espirro',
    'tosse leve',
    'dor de garganta',
    'resfriado',
    'vacina',
    'vacinacao',
    'consulta de rotina',
    'pre natal',
    'prenatal',
    'acompanhamento',
  ]);
  const saudeMentalSofrimento = contemAlgum(n, [
    'ansiedade',
    'panico',
    'depressao',
    'nao quero mais viver',
    'crise de choro',
    'insonia',
    'caps',
  ]);
  const riscoIminente = contemAlgum(n, [
    'quero me matar',
    'vou me matar',
    'tentativa de suicidio',
    'tentou suicidio',
    'risco de se machucar agora',
    'vai se machucar agora',
  ]);

  // Sintomas
  if (faltaDeAr) sintomas.push('falta de ar');
  if (dorPeito) sintomas.push('dor no peito');
  if (desmaio) sintomas.push('desmaio');
  if (confusao) sintomas.push('confusão');
  if (sangramento) sintomas.push('sangramento');
  if (febre) sintomas.push('febre');
  if (vomitos) sintomas.push('vômitos');

  // CORREÇÃO: trauma agora guarda o mecanismo, não apenas "queda"
  if (trauma) {
    if (contemAlgum(n, ['atropel', 'acidente', 'colisao', 'capotamento'])) {
      sintomas.push('trauma por acidente');
    } else if (contemAlgum(n, ['queda de altura', 'caiu de', 'precipitação'])) {
      sintomas.push('trauma por queda de altura');
    } else if (contemAlgum(n, ['cabeça', 'cabeca', 'concussão'])) {
      sintomas.push('trauma na cabeça');
    } else {
      sintomas.push('trauma');
    }
  }
  if (intoxicacao) sintomas.push('intoxicação');
  if (convulsao) sintomas.push('convulsão');
  if (dorAbdomen) sintomas.push('dor abdominal');
  if (fratura) sintomas.push('suspeita de fratura');
  if (queimadura) sintomas.push('queimadura');
  if (picada) sintomas.push('picada de animal peçonhento');
  if (ferida) sintomas.push('ferida');
  if (urinarios) sintomas.push('sintomas urinários');
  if (desidratacao) sintomas.push('fraqueza', 'dificuldade para manter líquidos');
  if (
    (sintomasLeves || contemAlgum(n, ['ubs', 'agendar consulta', 'clinica da familia'])) &&
    sintomas.length === 0
  ) {
    sintomas.push('sintomas leves ou rotina');
  }
  if (saudeMentalSofrimento) sintomas.push('sofrimento psíquico');
  if (contemAlgum(n, ['dor no corpo', 'dor pelo corpo'])) sintomas.push('dor no corpo');

  // Sinais de alerta
  marcar(trauma, sinais, 'trauma');
  marcar(confusao, sinais, 'alteração da consciência');
  marcar(faltaDeAr, sinais, 'falta_de_ar');
  marcar(dorPeito && (faltaDeAr || desmaio || suorFrio || confusao), sinais, 'dor_toracica_com_sinais_associados');
  marcar(avcSinais, sinais, 'sinais_neurologicos_subitos');
  marcar(riscoIminente, sinais, 'risco_iminente_autoagressao');
  marcar(convulsao, sinais, 'convulsao');

  // --- NOVA EXTRAÇÃO DE SINAIS OBSTÉTRICOS E TRAUMA ---
  const sinaisObstetricos = extrairSinaisObstetricos(n);
  const sinaisTrauma = extrairSinaisTrauma(n);
  // Adicionamos também ao array de sinais_alerta para consistência
  if (sinaisObstetricos.length) {
    sinais.push(...sinaisObstetricos);
  }
  if (sinaisTrauma.length) {
    sinais.push(...sinaisTrauma);
  }

  // Identificação de pessoa
  let pessoa = 'nao_informado';
  let terceiro = false;
  for (const [chave, rotulo] of Object.entries(TERCEIROS)) {
    if (n.includes(`minha ${chave}`) || n.includes(`meu ${chave}`)) {
      terceiro = true;
      pessoa = rotulo;
      break;
    }
  }

  let idade: RelatoEstruturado['idade_grupo'] = 'nao_informado';
  if (contemAlgum(n, ['bebe', 'recem nascido', 'meses de vida'])) idade = 'bebe';
  else if (contemAlgum(n, ['crianca', 'meu filho', 'minha filha'])) idade = 'crianca';
  else if (contemAlgum(n, ['adolescente'])) idade = 'adolescente';
  else if (contemAlgum(n, ['idoso'])) idade = 'idoso';
  else if (contemAlgum(n, ['adulto'])) idade = 'adulto';

  const duracaoMatch = n.match(/ha\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete)\s+(dia|dias|hora|horas|semana|semanas)/);
  const duracao = duracaoMatch ? duracaoMatch[0].replace('ha ', '') : 'nao_informado';

  const gestante = contemAlgum(n, ['gravida', 'gestante', 'estou gravida'])
    ? 'sim'
    : contemAlgum(n, ['nao estou gravida'])
      ? 'nao'
      : 'nao_informado';
  const posParto = contemAlgum(n, ['pos parto', 'depois do parto', 'tive bebe recentemente', 'puerperio'])
    ? 'sim'
    : 'nao_informado';

  let riscoMental: RelatoEstruturado['risco_mental'] = 'nao_mencionado';
  if (riscoIminente) riscoMental = 'iminente';
  else if (saudeMentalSofrimento) riscoMental = 'sem_risco_imediato';

  const temConteudoClinico =
    sintomas.length > 0 ||
    faltaDeAr ||
    dorPeito ||
    desmaio ||
    confusao ||
    febre ||
    trauma ||
    riscoIminente ||
    sinaisObstetricos.length > 0 ||
    sinaisTrauma.length > 0;

  const bruto: RelatoEstruturado = {
    ...RELATO_VAZIO,
    relato_sobre_terceiro: terceiro,
    pessoa,
    idade_grupo: idade,
    sintomas: unicos(sintomas),
    sinais_alerta: unicos(sinais),
    inicio: duracao !== 'nao_informado' ? duracao : 'nao_informado',
    duracao,
    piora: contemAlgum(n, ['piorando', 'piorou', 'cada vez pior']) ? 'sim' : 'nao_informado',
    intensidade: contemAlgum(n, ['dor forte', 'dor intensa', 'muito forte'])
      ? 'intensa'
      : contemAlgum(n, ['leve'])
        ? 'leve'
        : 'nao_informado',
    falta_de_ar: faltaDeAr ? true : 'nao_informado',
    dor_no_peito: dorPeito ? true : 'nao_informado',
    desmaio: desmaio ? true : 'nao_informado',
    confusao: confusao ? true : 'nao_informado',
    sangramento: sangramento ? true : 'nao_informado',
    febre: febre ? true : 'nao_informado',
    vomitos: vomitos ? true : 'nao_informado',
    trauma: trauma ? true : 'nao_informado',
    exposicao_intoxicacao: intoxicacao ? true : 'nao_informado',
    gestante,
    pos_parto: posParto,
    risco_mental: riscoMental,
    informacao_insuficiente: !temConteudoClinico,
    informacoes_contraditorias: [],
    // NOVOS CAMPOS
    sinais_obstetricos: unicos(sinaisObstetricos),
    sinais_trauma: unicos(sinaisTrauma),
  };

  return validarRelato(bruto).relato;
}

export async function interpretarRelato(texto: string): Promise<RelatoEstruturado> {
  // Extração determinística, mas mantemos a estrutura para compatibilidade
  const primeira = extrairInformacoes(texto);
  const validado = validarRelato(primeira);
  if (validado.ok) return validado.relato;
  // Se falhar, reextrai (mesmo resultado, mas mantido)
  const segunda = extrairInformacoes(texto);
  const revalidado = validarRelato(segunda);
  return revalidado.relato;
}