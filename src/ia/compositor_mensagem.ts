import type { DecisaoRegras, RelatoEstruturado } from './tipos.js';

const ABERTURAS: Record<string, string[]> = {
  SAMU_AGORA: [
    'Entendo, isso é preocupante e precisa de ajuda agora.',
    'Sinto muito que esteja passando por isso.',
    'Vamos agir rápido.',
  ],
  UPA_AGORA: [
    'Entendi o que você está sentindo.',
    'Obrigado por contar.',
    'Certo, vamos resolver isso.',
  ],
  HOJE: ['Ok, vamos lá.', 'Entendi.', 'Certo.'],
  AGENDAR: ['Certo.', 'Entendi.', 'Ok.'],
};

function sortear<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// [FIX] Dicionário expandido — antes só tinha 15 palavras; agora cobre
// sintomas comuns (náusea, vômito, convulsão) e partes do corpo.
const ACENTOS: Record<string, string> = {
  cabeca: 'cabeça', estomago: 'estômago', coracao: 'coração', pescoco: 'pescoço',
  musculo: 'músculo', garganta: 'garganta', barriga: 'barriga',
  ombro: 'ombro', joelho: 'joelho', pe: 'pé', braco: 'braço', coxa: 'coxa',
  olho: 'olho', olhos: 'olhos', ouvido: 'ouvido', dente: 'dente', dentes: 'dentes',
  coluna: 'coluna', tornozelo: 'tornozelo', punho: 'punho', mao: 'mão', maos: 'mãos',
  intestino: 'intestino', figado: 'fígado', rim: 'rim', rins: 'rins',
  pulmao: 'pulmão', pulmoes: 'pulmões', osso: 'osso', ossos: 'ossos',
  nausea: 'náusea', vomito: 'vômito', vomitos: 'vômitos',
  convulsao: 'convulsão', desidratacao: 'desidratação',
  hemorragia: 'hemorragia', tontura: 'tontura', tonturas: 'tonturas',
  infeccao: 'infecção', intoxicacao: 'intoxicação',
  queimacao: 'queimação', inchaco: 'inchaço', inchada: 'inchada', inchado: 'inchado',
  dor: 'dor', dores: 'dores', febre: 'febre', tosse: 'tosse',
  falta: 'falta', falta_de_ar: 'falta de ar',
  sangramento: 'sangramento', desmaio: 'desmaio', confusao: 'confusão',
  alergia: 'alergia', coceira: 'coceira', mancha: 'mancha', manchas: 'manchas',
  pressao: 'pressão', hipertensao: 'hipertensão',
  diarreia: 'diarreia', enjoo: 'enjoo',
  ardor: 'ardor', urinar: 'urinar',
};

function acentuar(texto: string): string {
  return texto.replace(/[a-z_]+/gi, (p) => ACENTOS[p.toLowerCase()] ?? p);
}

function espelhar(relato: RelatoEstruturado): string | null {
  const itens: string[] = [];
  if (relato.falta_de_ar === true) itens.push('falta de ar');
  if (relato.dor_no_peito === true) itens.push('dor no peito');
  if (relato.desmaio === true) itens.push('desmaio');
  if (relato.confusao === true) itens.push('confusão');
  if (relato.sangramento === true) itens.push('sangramento');
  if (relato.febre === true) itens.push('febre');
  if (relato.vomitos === true) itens.push('vômitos');

  const temDorEspecifica = relato.sintomas.some((s) => /^dor\s+\S+/.test(s));
  const primeiros = relato.sintomas
    .filter((s) => !/queixa inespec/i.test(s) && !(temDorEspecifica && s === 'dor'))
    .map(acentuar)
    .slice(0, 3);
  const combinados = [...new Set([...itens, ...primeiros])].slice(0, 3);
  if (combinados.length === 0) return null;

  if (combinados.length === 1) return `Você mencionou ${combinados[0]}.`;
  if (combinados.length === 2) return `Você mencionou ${combinados[0]} e ${combinados[1]}.`;
  return `Você mencionou ${combinados[0]}, ${combinados[1]} e ${combinados[2]}.`;
}

function blocoMotivos(decisao: DecisaoRegras): string | null {
  const motivos = (decisao.motivos || []).filter(Boolean);
  if (motivos.length === 0) return null;
  return `_Motivo da orientação: ${motivos.join(' + ')}._`;
}

export function comporResposta(params: {
  relato: RelatoEstruturado;
  decisao: DecisaoRegras;
  mensagemAprovada: string;
}): string {
  const { relato, decisao, mensagemAprovada } = params;
  const nivel = decisao.nivel || 'HOJE';
  const abertura = sortear(ABERTURAS[nivel] || ABERTURAS.HOJE);

  const blocos: string[] = [abertura];

  const espelho = espelhar(relato);
  if (espelho) blocos.push(espelho);

  blocos.push(mensagemAprovada);

  const motivo = blocoMotivos(decisao);
  if (motivo && nivel !== 'AGENDAR') blocos.push(motivo);

  return blocos.join('\n\n');
}