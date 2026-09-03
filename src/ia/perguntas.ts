export type TemaPergunta =
  | 'vago'
  | 'dor'
  | 'febre'
  | 'respiratorio'
  | 'falta_de_ar'
  | 'crianca'
  | 'gestacao'
  | 'saude_mental';

export const PERGUNTAS: Record<TemaPergunta, string[]> = {
  vago: [
    'O que você está sentindo e há quanto tempo começou?',
    'Você está com falta de ar, dor no peito, desmaio ou confusão?',
  ],
  febre: [
    'Há quantos dias você está com febre?',
    'Está conseguindo beber líquidos normalmente ou sente muita fraqueza e prostração?',
  ],
  respiratorio: [
    'Você tem falta de ar ou chiado no peito ao respirar?',
    'A tosse ou secreção começou há quanto tempo? Há febre associada?',
  ],
  dor: [
    'A dor começou de repente ou já dura vários dias?',
    'Há outros sintomas juntos, como vômitos persistentes, febre, desmaio ou sangramento?',
  ],
  falta_de_ar: [
    'Você consegue falar frases inteiras sem parar para respirar?',
    'Há lábios arroxeados, desmaio ou confusão?',
  ],
  crianca: [
    'Qual é a idade da criança?',
    'Ela está alerta, respirando normalmente e conseguindo beber líquidos?',
  ],
  gestacao: [
    'A pessoa está grávida ou teve bebê recentemente?',
    'Há sangramento, perda de líquido, dor forte, desmaio ou redução dos movimentos do bebê?',
  ],
  saude_mental: [
    'Existe risco de a pessoa se machucar ou machucar alguém agora?',
    'Houve tentativa recente, intoxicação, desmaio ou dificuldade para respirar?',
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
  // 1. Grupos prioritários e saúde mental
  if (params.risco_mental === 'sem_risco_imediato') return 'saude_mental';
  if (params.idade_grupo === 'bebe' || params.idade_grupo === 'crianca') return 'crianca';
  if (params.gestante === 'nao_informado' && params.sintomas.some((s) => s.includes('sangramento'))) {
    return 'gestacao';
  }
  if (params.falta_de_ar === true) return 'falta_de_ar';

  // 2. Novos temas de refinamento clínico
  if (params.febre === true || params.sintomas.includes('febre')) {
    return 'febre';
  }
  if (params.sintomas.some((s) => s.includes('tosse') || s.includes('resfriado') || s.includes('garganta'))) {
    return 'respiratorio';
  }
  if (params.sintomas.some((s) => s.includes('dor') || s.includes('barriga') || s.includes('costas'))) {
    return 'dor';
  }

  // 3. Padrão para relatos genéricos
  return 'vago';
}