// src/ia/base_conhecimento.ts
// Pesquisa na base usando busca vetorial (semântica). Encontra tópicos
// relevantes mesmo quando o usuário usa palavras diferentes das cadastradas.

import { GoogleGenAI } from '@google/genai';
import type { Sql } from '../whatsapp/persistencia_sessao.js';
import { gerarEmbedding } from '../servicos/embeddings.js';
import { normalizarTexto } from './normalizar.js';
import baseLocal from '../regras/base_conhecimento.json';

// ────────────────────────────────────────────────────
// Cliente DB
// ────────────────────────────────────────────────────
let sqlCliente: Sql | null = null;
export function registrarClienteDb(sql: Sql | null): void {
  sqlCliente = sql;
  console.log(`📌 [RAG] cliente DB ${sql ? 'registrado' : 'NULO'}`);
}

// ────────────────────────────────────────────────────
// Busca vetorial
// ────────────────────────────────────────────────────
type ResultadoDb = {
  id: string;
  titulo: string;
  conteudo: string;
  similaridade: number;
};

async function buscarTopK(pergunta: string, k = 5): Promise<ResultadoDb[]> {
  if (!sqlCliente) {
    console.log(`⚠️ [RAG] sqlCliente NULO — busque vetorial pulada`);
    return [];
  }

  const vetor = await gerarEmbedding(pergunta);
  if (!vetor) {
    console.log(`⚠️ [RAG] embedding retornou null para "${pergunta}"`);
    return [];
  }
  console.log(`🧮 [RAG] embedding gerado com ${vetor.length} dimensões`);

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

    console.log(`🔍 [RAG] "${pergunta}" → ${linhas.length} candidatos, top similaridade: ${linhas[0]?.similaridade?.toFixed(3) ?? 'n/a'}`);

    const filtradas = linhas.filter((l) => l.similaridade > 0.5);
    console.log(`   Após filtro >0.5: ${filtradas.length}`);
    return filtradas;
  } catch (err: any) {
    console.error(`❌ [RAG] busca vetorial FALHOU:`, err?.message || err);
    return [];
  }
}

// ────────────────────────────────────────────────────
// Fallback keyword
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
export async function responderDaBase(pergunta: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log(`⚠️ [RAG] GEMINI_API_KEY ausente`);
    return null;
  }

  let contextoTexto = '';
  const candidatosVetoriais = await buscarTopK(pergunta, 5);

  if (candidatosVetoriais.length > 0) {
    contextoTexto = candidatosVetoriais
      .map((t) => `### ${t.titulo}\n${t.conteudo}`)
      .join('\n\n---\n\n');
    console.log(`✅ [RAG] usando ${candidatosVetoriais.length} tópicos vetoriais`);
  } else {
    const candidatosLocais = buscarLocalKeyword(pergunta, 3);
    if (candidatosLocais.length === 0) {
      console.log(`❌ [RAG] sem tópicos (nem vetorial nem local) para "${pergunta}"`);
      return null;
    }
    contextoTexto = candidatosLocais
      .map((t) => `### ${t.titulo}\n${t.conteudo}`)
      .join('\n\n---\n\n');
    console.log(`🔄 [RAG] usando fallback keyword: ${candidatosLocais.length} tópicos`);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const promessa = ai.models.generateContent({
      model: 'gemini-3.6-flash',
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
      console.log(`❌ [RAG] Gemini devolveu NAO_ENCONTRADO`);
      return null;
    }
    if (texto.length < 20) {
      console.log(`❌ [RAG] resposta curta demais (${texto.length} chars)`);
      return null;
    }
    console.log(`✅ [RAG] resposta gerada (${texto.length} chars)`);
    return texto;
  } catch (err: any) {
    console.error('❌ [RAG] Gemini falhou:', err?.message || err);
    return null;
  }
}

export async function temTopicoRelevante(pergunta: string): Promise<boolean> {
  const vetoriais = await buscarTopK(pergunta, 1);
  if (vetoriais.length > 0) return true;
  const local = buscarLocalKeyword(pergunta, 1);
  console.log(`🔎 [RAG] temTopicoRelevante("${pergunta}") = ${local.length > 0} (fallback local)`);
  return local.length > 0;
}