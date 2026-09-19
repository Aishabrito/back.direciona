

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

function espelhar(relato: RelatoEstruturado): string | null {
  const itens: string[] = [];
  if (relato.falta_de_ar === true) itens.push('falta de ar');
  if (relato.dor_no_peito === true) itens.push('dor no peito');
  if (relato.desmaio === true) itens.push('desmaio');
  if (relato.confusao === true) itens.push('confusão');
  if (relato.sangramento === true) itens.push('sangramento');
  if (relato.febre === true) itens.push('febre');
  if (relato.vomitos === true) itens.push('vômitos');

  const primeiros = relato.sintomas.slice(0, 3).filter((s) => !/queixa inespec/i.test(s));
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