// src/ia/base_conhecimento.ts
// RAG como FERRAMENTA do decisor: o decisor escolhe acao="responder_rag",
// o código busca os tópicos e o LLM redige a resposta final com eles.
// A validação final (validacao_final.ts) roda sobre o texto, como em qualquer ação.

import type { Sql } from '../whatsapp/persistencia_sessao.js';
import { gerarEmbedding } from '../servicos/embeddings.js';
import { gerarJSON, type JsonSchema, type UsoLLM } from '../servicos/ia.js';
import { normalizarTexto } from './normalizar.js';
import baseLocal from '../regras/base_conhecimento.json';

let sqlCliente: Sql | null = null;
export function registrarClienteDb(sql: Sql | null): void {
  sqlCliente = sql;
  console.log(`📌 [RAG] cliente DB ${sql ? 'registrado' : 'NULO'}`);
}

export type Topico = { id: string; titulo: string; conteudo: string; similaridade?: number };

export type RespostaRAG = {
  texto: string;
  topico_id: string;
  origem: 'llm' | 'topico_direto' | 'sem_topico' | 'cache';
  uso?: UsoLLM;
};

// ────────────────────────────────────────────────────
// CACHE de respostas redigidas — TTL 1h, 500 entradas.
// A chave é a pergunta_rag, que o decisor já reescreve de forma independente
// do histórico. Não cacheia falhas (evita "grudar" um erro transitório).
// ────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { resposta: RespostaRAG; expiraEm: number }>();

function lerCache(chave: string): RespostaRAG | null {
  const e = cache.get(chave);
  if (!e) return null;
  if (Date.now() > e.expiraEm) { cache.delete(chave); return null; }
  return e.resposta;
}

function gravarCache(chave: string, resposta: RespostaRAG): void {
  if (cache.size >= CACHE_MAX) {
    const maisAntiga = cache.keys().next().value;
    if (maisAntiga !== undefined) cache.delete(maisAntiga);
  }
  cache.set(chave, { resposta, expiraEm: Date.now() + CACHE_TTL_MS });
}

// ────────────────────────────────────────────────────
// BUSCA: vetorial (Supabase/pgvector) → keyword local
// ────────────────────────────────────────────────────
async function buscarVetorial(pergunta: string, k: number): Promise<Topico[]> {
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
    `) as Topico[];
    return linhas.filter((l) => (l.similaridade ?? 0) > 0.5);
  } catch (err: any) {
    console.error('❌ [RAG] busca vetorial falhou:', err?.message || err);
    return [];
  }
}

type TopicoLocal = Topico & { tags: string[] };
const TOPICOS_LOCAIS: TopicoLocal[] = (baseLocal as { topicos?: TopicoLocal[] }).topicos ?? [];

// Palavras que aparecem em quase toda pergunta e não ajudam a achar o tópico.
const VAZIAS = new Set(['que', 'qual', 'quais', 'como', 'para', 'pra', 'com', 'uma', 'por', 'sobre', 'isso', 'quando', 'onde', 'tem', 'ter', 'sao', 'ser', 'esta', 'fazer', 'posso', 'devo']);

function buscarKeyword(pergunta: string, k: number): Topico[] {
  const tokens = normalizarTexto(pergunta).split(/\s+/).filter((p) => p.length > 2 && !VAZIAS.has(p));
  if (tokens.length === 0) return [];
  return TOPICOS_LOCAIS
    .map((t) => {
      const cabecalho = normalizarTexto(`${t.titulo} ${t.tags.join(' ')}`);
      const corpo = normalizarTexto(t.conteudo);
      // Título/tags valem mais que corpo.
      const score = tokens.reduce((s, tk) => s + (cabecalho.includes(tk) ? 3 : corpo.includes(tk) ? 1 : 0), 0);
      return { t, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.t);
}

export async function buscarTopicos(pergunta: string, k = 4): Promise<Topico[]> {
  const vetoriais = await buscarVetorial(pergunta, k);
  if (vetoriais.length > 0) return vetoriais;
  return buscarKeyword(pergunta, Math.min(k, 3));
}

// ────────────────────────────────────────────────────
// REDAÇÃO
// ────────────────────────────────────────────────────
const RAG_SYSTEM = `Você é o Direciona SUS e responde dúvidas GERAIS de saúde e sobre serviços do SUS usando SOMENTE a base fornecida.

REGRAS INVIOLÁVEIS
1. NUNCA diga o que a pessoa "pode ter", "parece ter" ou que os sintomas dela "indicam" algo.
2. NUNCA recomende remédio, dose ou tratamento.
3. Use só a BASE. Se a base não responder, devolva texto="NAO_ENCONTRADO".

ESTILO
- Responda só o que foi perguntado, em 1 a 3 parágrafos curtos (WhatsApp).
- Sem cumprimentos e sem "espero ter ajudado".
- Quando fizer sentido, diga em 1 frase quando procurar UBS, UPA ou SAMU 192.

Responda SOMENTE com JSON: {"texto": "..."}`;

const RAG_SCHEMA: JsonSchema = {
  name: 'resposta_rag',
  strict: true,
  schema: {
    type: 'object',
    properties: { texto: { type: 'string' } },
    required: ['texto'],
    additionalProperties: false,
  },
};

function respostaDireta(topico: Topico): string {
  const paragrafos = topico.conteudo.split(/\n\n+/).filter(Boolean).slice(0, 2).join('\n\n');
  return `*${topico.titulo}*\n\n${paragrafos}`;
}

export const TEXTO_SEM_TOPICO =
  'Não tenho uma informação confiável sobre isso na minha base. Para essa dúvida, o melhor é conversar com a equipe da UBS mais próxima. ' +
  'Se você estiver com algum sintoma agora, me conta que eu te oriento onde buscar atendimento.';

export async function responderComBase(pergunta: string): Promise<RespostaRAG> {
  const chave = normalizarTexto(pergunta).slice(0, 200);
  const cacheado = lerCache(chave);
  if (cacheado) return { ...cacheado, origem: 'cache', uso: undefined };

  const topicos = await buscarTopicos(pergunta);
  if (topicos.length === 0) {
    return { texto: TEXTO_SEM_TOPICO, topico_id: 'sem_topico', origem: 'sem_topico' };
  }

  const base = topicos.map((t) => `### ${t.titulo}\n${t.conteudo}`).join('\n\n---\n\n');
  const resp = await gerarJSON<{ texto?: unknown }>(
    `PERGUNTA: "${pergunta}"\n\nBASE:\n${base}`,
    RAG_SYSTEM,
    15000,
    RAG_SCHEMA,
  );

  const texto = typeof resp?.dados?.texto === 'string' ? resp.dados.texto.trim() : '';
  if (!texto || texto.includes('NAO_ENCONTRADO') || texto.length < 20) {
    // LLM fora do ar ou sem resposta: devolve o tópico mais relevante direto (conteúdo curado).
    return { texto: respostaDireta(topicos[0]), topico_id: topicos[0].id, origem: 'topico_direto', uso: resp?.uso };
  }

  const resposta: RespostaRAG = { texto, topico_id: topicos[0].id, origem: 'llm', uso: resp?.uso };
  gravarCache(chave, resposta);
  return resposta;
}
