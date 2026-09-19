import type { RelatoEstruturado, UltimaPergunta } from './tipos';

export type TemaPergunta =
  | 'vago' | 'dor' | 'febre' | 'respiratorio'
  | 'falta_de_ar' | 'crianca' | 'gestacao' | 'saude_mental';

export type Pergunta = {
  id: string;
  texto: string;
  campoAlvo?: keyof RelatoEstruturado;
  quando?: (r: RelatoEstruturado) => boolean;
};

export const PERGUNTAS: Record<TemaPergunta, Pergunta[]> = {
  vago: [
    { id: 'vago_oque', texto: 'O que você está sentindo e há quanto tempo começou?', campoAlvo: 'sintomas' },
    { id: 'vago_duracao', texto: 'Isso começou há quantos dias?', campoAlvo: 'duracao' },
  ],
  febre: [
    { id: 'febre_duracao', texto: 'Há quantos dias você está com febre?', campoAlvo: 'duracao' },
    { id: 'febre_liquidos', texto: 'Você está conseguindo beber líquidos ou sente muita fraqueza?', campoAlvo: 'consegue_beber' },
  ],
  respiratorio: [
    { id: 'resp_falta_ar', texto: 'Você está com falta de ar ou chiado no peito?', campoAlvo: 'falta_de_ar' },
    { id: 'resp_duracao', texto: 'A tosse começou há quantos dias?', campoAlvo: 'duracao' },
  ],
  dor: [
    { id: 'dor_tempo', texto: 'A dor começou de repente ou já dura vários dias?', campoAlvo: 'duracao' },
    { id: 'dor_assoc', texto: 'Há vômitos, febre, desmaio ou sangramento junto?', campoAlvo: 'sinais_alerta' },
  ],
  falta_de_ar: [
    { id: 'falta_frases', texto: 'Você consegue falar uma frase inteira sem parar pra respirar?', campoAlvo: 'fala_frases' },
    { id: 'falta_labios', texto: 'Seus lábios estão arroxeados? Você está confuso ou com muito suor?', campoAlvo: 'labios_roxos' },
  ],
  crianca: [
    { id: 'crianca_idade', texto: 'Qual é a idade da criança?', campoAlvo: 'idade_numerica' },
    { id: 'crianca_alerta', texto: 'Ela está alerta, respirando normalmente e conseguindo beber líquidos?', campoAlvo: 'consegue_beber' },
  ],
  gestacao: [
    { id: 'gest_confirmacao', texto: 'A pessoa está grávida ou teve bebê recentemente?', campoAlvo: 'gestante' },
    { id: 'gest_sinais', texto: 'Há sangramento, perda de líquido, dor forte ou redução dos movimentos do bebê?' },
  ],
  saude_mental: [
    { id: 'mental_risco', texto: 'Existe risco de a pessoa se machucar ou machucar alguém agora?', campoAlvo: 'risco_mental' },
    { id: 'mental_intox', texto: 'Houve tentativa recente, intoxicação ou desmaio?' },
  ],
};

export function escolherTemaPergunta(params: {
  sintomas: string[];
  idade_grupo: string;
  gestante: string;
  risco_mental: string;
  falta_de_ar: boolean | 'nao_informado';
  febre?: boolean | 'nao_informado';
}): TemaPergunta {
  if (params.risco_mental === 'sem_risco_imediato') return 'saude_mental';
  if (params.idade_grupo === 'bebe' || params.idade_grupo === 'crianca') return 'crianca';
  if (params.gestante === 'nao_informado' && params.sintomas.some((s) => s.includes('sangramento'))) return 'gestacao';
  if (params.falta_de_ar === true) return 'falta_de_ar';
  if (params.febre === true || params.sintomas.includes('febre')) return 'febre';
  if (params.sintomas.some((s) => /tosse|resfriado|garganta/.test(s))) return 'respiratorio';
  if (params.sintomas.some((s) => /dor|barriga|costas|cabeca/.test(s))) return 'dor';
  return 'vago';
}

export function escolherProximaPergunta(
  tema: TemaPergunta,
  relato: RelatoEstruturado,
  perguntasJaFeitas: string[],
): Pergunta | null {
  const lista = PERGUNTAS[tema] || PERGUNTAS.vago;
  for (const p of lista) {
    if (perguntasJaFeitas.includes(p.id)) continue;
    if (p.quando && !p.quando(relato)) continue;
    return p;
  }
  return null;
}

// Só trata como resposta curta se a mensagem for MESMO curta.
// "não, mas estou com dor" tem mais de 5 palavras → não é resposta curta.
const SO_CURTA =
  /^\s*(sim|s|nao|n|não|ok|isso|claro|positivo|negativo|afirmativo|talvez|nao sei|não sei|nao tenho certeza|consigo|nao consigo|nao posso|não posso|acabei de falar|ja falei|já falei)\s*$/i;

export function interpretarRespostaCurta(
  texto: string,
  ultima: UltimaPergunta | undefined,
): Partial<RelatoEstruturado> | null {
  if (!ultima?.campoAlvo) return null;
  const n = texto.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  if (!SO_CURTA.test(n)) return null;

  const sim = /^(sim|s|ok|isso|claro|positivo|afirmativo|consigo|tenho|estou)$/.test(n);
  const nao = /^(nao|n|nunca|negativo|nao tenho|nao estou|nao consigo|nao posso)$/.test(n);

  const campo = ultima.campoAlvo;

  const flags: (keyof RelatoEstruturado)[] = [
    'falta_de_ar', 'dor_no_peito', 'desmaio', 'confusao', 'sangramento',
    'febre', 'vomitos', 'trauma', 'fala_frases', 'labios_roxos',
    'consegue_beber', 'alergia_grave',
  ];
  if (flags.includes(campo)) {
    if (sim) return { [campo]: true } as Partial<RelatoEstruturado>;
    if (nao) return { [campo]: false } as Partial<RelatoEstruturado>;
    return null;
  }

  if (campo === 'gestante' || campo === 'pos_parto') {
    if (sim) return { [campo]: 'sim' } as Partial<RelatoEstruturado>;
    if (nao) return { [campo]: 'nao' } as Partial<RelatoEstruturado>;
    return null;
  }

  if (campo === 'risco_mental') {
    if (sim) return { risco_mental: 'iminente' };
    if (nao) return { risco_mental: 'sem_risco_imediato' };
    return null;
  }

  return null;
}