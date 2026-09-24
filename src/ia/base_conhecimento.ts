// src/ia/base_conhecimento.ts
// Pesquisa na base usando busca vetorial (semântica) + resposta via Groq.

import type { Sql } from '../whatsapp/persistencia_sessao.js';
import { gerarEmbedding } from '../servicos/embeddings.js';
import { gerarTexto } from '../servicos/ia.js';
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
    console.log(`⚠️ [RAG] sqlCliente NULO`);
    return [];
  }

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

    console.log(`🔍 [RAG] "${pergunta}" → ${linhas.length} candidatos, top: ${linhas[0]?.similaridade?.toFixed(3) ?? 'n/a'}`);
    return linhas.filter((l) => l.similaridade > 0.5);
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
// Resposta direta (fallback se LLM falha)
// ────────────────────────────────────────────────────
function montarRespostaDireta(topico: { titulo: string; conteudo: string }): string {
  const paragrafos = topico.conteudo.split('\n\n').filter(Boolean);
  const trecho = paragrafos.slice(0, 2).join('\n\n');
  return `*${topico.titulo}*\n\n${trecho}`;
}

// ────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────
export async function responderDaBase(pergunta: string): Promise<string | null> {
  let contextoTexto = '';
  let primeiroTopico: { titulo: string; conteudo: string } | null = null;

  const candidatosVetoriais = await buscarTopK(pergunta, 5);

  if (candidatosVetoriais.length > 0) {
    contextoTexto = candidatosVetoriais
      .map((t) => `### ${t.titulo}\n${t.conteudo}`)
      .join('\n\n---\n\n');
    primeiroTopico = candidatosVetoriais[0];
    console.log(`✅ [RAG] usando ${candidatosVetoriais.length} tópicos vetoriais`);
  } else {
    const candidatosLocais = buscarLocalKeyword(pergunta, 3);
    if (candidatosLocais.length === 0) {
      console.log(`❌ [RAG] sem tópicos para "${pergunta}"`);
      return null;
    }
    contextoTexto = candidatosLocais
      .map((t) => `### ${t.titulo}\n${t.conteudo}`)
      .join('\n\n---\n\n');
    primeiroTopico = candidatosLocais[0];
    console.log(`🔄 [RAG] usando fallback keyword: ${candidatosLocais.length} tópicos`);
  }

  const prompt = `PERGUNTA DO USUÁRIO:
"${pergunta}"

BASE DE CONHECIMENTO (use SOMENTE isto):
${contextoTexto}`;

  const systemInstruction = `Você é um agente do SUS explicando para um usuário comum.
Responda à pergunta em português, de forma clara e acolhedora.
Se a base não tiver a informação suficiente, devolva EXATAMENTE a string NAO_ENCONTRADO e nada mais.`;

  const texto = await gerarTexto(prompt, systemInstruction, 20000);

  if (!texto || texto === 'NAO_ENCONTRADO' || texto.includes('NAO_ENCONTRADO')) {
    console.log(`⚠️ [RAG] Groq sem resposta, usando tópico direto`);
    return primeiroTopico ? montarRespostaDireta(primeiroTopico) : null;
  }
  if (texto.length < 20) {
    console.log(`⚠️ [RAG] resposta curta, usando tópico direto`);
    return primeiroTopico ? montarRespostaDireta(primeiroTopico) : null;
  }

  console.log(`✅ [RAG] resposta gerada pelo Groq (${texto.length} chars)`);
  return texto;
}

export async function temTopicoRelevante(pergunta: string): Promise<boolean> {
  const vetoriais = await buscarTopK(pergunta, 1);
  if (vetoriais.length > 0) return true;
  return buscarLocalKeyword(pergunta, 1).length > 0;
}