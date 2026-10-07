// Estado da conexão do WhatsApp, para o endpoint /status (o /health só diz se o processo está de pé).
export type EstadoConexao = 'iniciando' | 'aguardando_qr' | 'conectado' | 'reconectando' | 'parado';

const status = {
  estado: 'iniciando' as EstadoConexao,
  desde: new Date().toISOString(),
  ultimaDesconexao: null as null | { codigo: number | null; motivo: string; em: string },
};

export function setEstadoConexao(estado: EstadoConexao): void {
  if (status.estado === estado) return;
  status.estado = estado;
  status.desde = new Date().toISOString();
}

export function registrarDesconexao(codigo: number | null, motivo: string): void {
  status.ultimaDesconexao = { codigo, motivo, em: new Date().toISOString() };
}

export function getStatusWhatsApp() {
  return { ...status };
}
