

import { createHash } from 'crypto';
import type { Sql } from './persistencia_sessao.js';
import { ESTADO_INICIAL } from '../ia/orquestrador.js';
import type { EstadoConversa } from '../ia/tipos.js';

const VERSAO_ESTADO = 1;

function hashSender(sender: string): string {
  return createHash('sha256').update(sender).digest('hex').slice(0, 16);
}

export async function inicializarTabelaEstado(sql: Sql | null): Promise<void> {
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS estados_conversa (
      sender_hash TEXT PRIMARY KEY,
      estado JSONB NOT NULL,
      versao INT NOT NULL DEFAULT 1,
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log('✅ Tabela estados_conversa pronta.');
}

export async function salvarEstado(
  sql: Sql | null,
  sender: string,
  estado: EstadoConversa,
): Promise<void> {
  if (!sql) return;
  try {
    const hash = hashSender(sender);
    await sql`
      INSERT INTO estados_conversa (sender_hash, estado, versao, atualizado_em)
      VALUES (${hash}, ${sql.json(estado)}, ${VERSAO_ESTADO}, NOW())
      ON CONFLICT (sender_hash)
      DO UPDATE SET estado = ${sql.json(estado)}, versao = ${VERSAO_ESTADO}, atualizado_em = NOW()
    `;
  } catch (err) {
    console.error('❌ Erro ao salvar estado:', err);
  }
}

export async function carregarEstado(
  sql: Sql | null,
  sender: string,
): Promise<EstadoConversa | null> {
  if (!sql) return null;
  try {
    const hash = hashSender(sender);
    const linhas = (await sql`
      SELECT estado, versao FROM estados_conversa WHERE sender_hash = ${hash}
    `) as Array<{ estado: EstadoConversa; versao: number }>;

    if (linhas.length === 0) return null;

    // [FIX Bloco 2] Se a versão do schema mudou, descarta (pode ter campos novos/faltando)
    if (linhas[0].versao !== VERSAO_ESTADO) {
      console.log('⚠️ Estado antigo (versão diferente). Descartando.');
      return null;
    }

    return linhas[0].estado;
  } catch (err) {
    console.error('❌ Erro ao carregar estado:', err);
    return null;
  }
}

export async function apagarEstado(sql: Sql | null, sender: string): Promise<void> {
  if (!sql) return;
  try {
    const hash = hashSender(sender);
    await sql`DELETE FROM estados_conversa WHERE sender_hash = ${hash}`;
  } catch (err) {
    console.error('❌ Erro ao apagar estado:', err);
  }
}