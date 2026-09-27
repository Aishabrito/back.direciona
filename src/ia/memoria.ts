// src/ia/memoria.ts
// Memória estruturada (fatos sobre o usuário) + detecção de reformulação.

import { normalizarTexto } from './normalizar.js';
import { MEMORIA_VAZIA, type FatosUsuario, type MemoriaUsuario, type MensagemHistorico } from './tipos.js';

export const TURNOS_POR_RESUMO = 10;

/** Junta fatos novos aos conhecidos. Valor novo explícito substitui o antigo; listas são unidas. */
export function mesclarFatos(atuais: FatosUsuario, novos?: FatosUsuario): FatosUsuario {
  if (!novos) return atuais;
  const r: FatosUsuario = { ...atuais };
  if (novos.idade !== undefined) r.idade = novos.idade;
  if (novos.idade_grupo !== undefined) r.idade_grupo = novos.idade_grupo;
  if (novos.gestante !== undefined) r.gestante = novos.gestante;
  if (novos.mora_em) r.mora_em = novos.mora_em;
  if (novos.pessoa_atendida) r.pessoa_atendida = novos.pessoa_atendida;
  if (novos.doencas_cronicas?.length) {
    const vistos = new Set((r.doencas_cronicas ?? []).map(normalizarTexto));
    r.doencas_cronicas = [
      ...(r.doencas_cronicas ?? []),
      ...novos.doencas_cronicas.filter((d) => !vistos.has(normalizarTexto(d))),
    ].slice(0, 10);
  }
  return r;
}

export function atualizarMemoria(
  memoria: MemoriaUsuario | undefined,
  fatosNovos?: FatosUsuario,
  resumoNovo?: string,
): MemoriaUsuario {
  const m = memoria ?? MEMORIA_VAZIA;
  const fatos = mesclarFatos(m.fatos ?? {}, fatosNovos);
  if (resumoNovo) return { fatos, resumo: resumoNovo, turnosDesdeResumo: 0 };
  return { fatos, resumo: m.resumo, turnosDesdeResumo: (m.turnosDesdeResumo ?? 0) + 1 };
}

export function deveAtualizarResumo(memoria: MemoriaUsuario | undefined): boolean {
  return (memoria?.turnosDesdeResumo ?? 0) >= TURNOS_POR_RESUMO - 1;
}

// ────────────────────────────────────────────────────
// REFORMULAÇÃO — o usuário mandou de novo (quase) a mesma coisa
// ────────────────────────────────────────────────────
function tokens(texto: string): Set<string> {
  return new Set(normalizarTexto(texto).split(/\s+/).filter((p) => p.length > 2));
}

/**
 * true se a mensagem atual é igual/parecida com a última do usuário.
 * Mensagens curtas ("sim", "não", "ok") nunca contam — são respostas a perguntas diferentes.
 */
export function ehReformulacao(atual: string, historico: MensagemHistorico[] | undefined): boolean {
  const anterior = [...(historico ?? [])].reverse().find((m) => m.role === 'user')?.content;
  if (!anterior) return false;
  const a = tokens(atual);
  const b = tokens(anterior);
  if (a.size < 3 || b.size < 3) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  return jaccard >= 0.6;
}
