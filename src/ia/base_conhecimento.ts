// src/ia/base_conhecimento.ts
// Pesquisa na base usando busca vetorial (semântica). Encontra tópicos
// relevantes mesmo quando o usuário usa palavras diferentes das cadastradas.
//
// Fallback: se o Supabase não estiver disponível, cai no JSON local
// com busca por palavra-chave (comportamento antigo).

import { GoogleGenAI } from '@google/genai';
import type { Sql } from '../whatsapp/persistencia_sessao.js';
import { gerarEmbedding } from '../servicos/embeddings.js';
import { normalizarTexto } from './normalizar.js';
import baseLocal from '../regras/base_conhecimento.json';

// ────────────────────────────────────────────────────
// Cliente DB — registrado pelo bot.ts no boot
// ────────────────────────────────────────────────────
let sqlCliente: Sql | null = null;
export function registrarClienteDb(sql: Sql | null): void {
  sqlCliente = sql;
}

// ────────────────────────────────────────────────────
// Busca vetorial (principal)
// ────────────────────────────────────────────────────
type ResultadoDb = {
  id: string;
  titulo: string;
  conteudo: string;
  similaridade: number;
};

async function buscarTopK(pergunta: string, k = 5): Promise<ResultadoDb[]> {
  if (!sqlCliente) return [];

  const vetor = await gerarEmbedding(pergunta);
  if (!vetor) return [];

  const vetorStr = `[${vetor.join(',')}]`;

  try {
    const linhas = (await sqlCliente`
      SELECT id, titulo, conteudo,
             1 - (embedding <=> ${vetorStr}::vector) AS similaridade
      FROM base_conhecimento
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vetorStr}::vector
      LIMIT ${k}
    `) as ResultadoDb[];

    // Só considera tópicos com similaridade decente (>0.6)
    return linhas.filter((l) => l.similaridade > 0.6);
  } catch (err) {
    console.error('❌ Busca vetorial falhou:', err);
    return [];
  }
}

// ────────────────────────────────────────────────────
// Fallback: busca por keyword no JSON local
// ────────────────────────────────────────────────────
type TopicoLocal = {
  id: string;
  titulo: string;
  tags: string[];
  conteudo: string;
};

const TOPICOS_LOCAIS = ((baseLocal as { topicos?: TopicoLocal[] }).topicos ?? []);

function pontuarLocal(pergunta: string, topico: TopicoLocal): number {
  const tokens = normalizarTexto(pergunta).split(/\s+/).filter((p) => p.length > 2);
  const texto = normalizarTexto(`${topico.titulo} ${topico.tags.join(' ')} ${topico.conteudo}`);
  let acertos = 0;
  for (const t of tokens) if (texto.includes(t)) acertos++;
  return acertos;
}

function buscarLocalKeyword(pergunta: string, k = 3): TopicoLocal[] {
  return TOPICOS_LOCAIS
    .map((t) => ({ t, score: pontuarLocal(pergunta, t) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.t);
}

// ────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────

/**
 * Responde uma pergunta de saúde usando a base de conhecimento.
 * Tenta busca vetorial (Supabase); se falhar, cai em keyword local.
 */
export async function responderDaBase(pergunta: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // 1. Tenta busca vetorial
  let contextoTexto = '';
  let candidatosVetoriais = await buscarTopK(pergunta, 5);

  if (candidatosVetoriais.length > 0) {
    contextoTexto = candidatosVetoriais
      .map((t) => `### ${t.titulo}\n${t.conteudo}`)
      .join('\n\n---\n\n');
  } else {
    // 2. Fallback: keyword local
    const candidatosLocais = buscarLocalKeyword(pergunta, 3);
    if (candidatosLocais.length === 0) return null;
    contextoTexto = candidatosLocais
      .map((t) => `### ${t.titulo}\n${t.conteudo}`)
      .join('\n\n---\n\n');
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const promessa = ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `PERGUNTA DO USUÁRIO:
"${pergunta}"

BASE DE CONHECIMENTO (use SOMENTE isto):
${contextoTexto}

Responda à pergunta em português, de forma clara e acolhedora, como se fosse um agente do SUS explicando para um usuário comum. Se a base não tiver a informação para responder, devolva EXATAMENTE a string NAO_ENCONTRADO e nada mais.`,
      config: { temperature: 0 },
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout base')), 8000),
    );
    const resp = (await Promise.race([promessa, timeout])) as any;
    const texto = (resp.text || '').trim();

    if (!texto || texto === 'NAO_ENCONTRADO' || texto.includes('NAO_ENCONTRADO')) {
      return null;
    }
    return texto.length > 20 ? texto : null;
  } catch (err) {
    console.error('❌ Base de conhecimento falhou:', err);
    return null;
  }
}

/** Verifica rapidamente se vale a pena consultar a base. */
export async function temTopicoRelevante(pergunta: string): Promise<boolean> {
  const vetoriais = await buscarTopK(pergunta, 1);
  if (vetoriais.length > 0) return true;
  return buscarLocalKeyword(pergunta, 1).length > 0;
}