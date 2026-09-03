import type { DecisaoRegras } from './tipos';

export type EventoAuditoria = {
  em: string;
  regra_acionada: string;
  categoria_interna: DecisaoRegras['categoria_interna'];
  destino: DecisaoRegras['destino'];
  resposta_id: string;
  versao_regras: string;
};

const eventos: EventoAuditoria[] = [];

export function registrarDecisao(decisao: DecisaoRegras): EventoAuditoria {
  const evento: EventoAuditoria = {
    em: new Date().toISOString(),
    regra_acionada: decisao.regra_acionada,
    categoria_interna: decisao.categoria_interna,
    destino: decisao.destino,
    resposta_id: decisao.resposta_id,
    versao_regras: decisao.versao_regras,
  };
  eventos.push(evento);
  if (eventos.length > 50) eventos.shift();
  return evento;
}

export function ultimosEventos(): EventoAuditoria[] {
  return [...eventos];
}
