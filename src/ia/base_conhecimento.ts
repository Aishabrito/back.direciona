
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
// Tipo público — o orquestrador monta a mensagem a partir disso.
// ────────────────────────────────────────────────────
export type RespostaEstruturada = {
  titulo: string;
  corpo: string;
  topico_id: string;
  origem: 'vetorial' | 'keyword' | 'fallback_direto';
  similaridade?: number;
  bloqueado?: boolean; // true se o judge reprovou; corpo já é o seguro
};

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
    console.log(
      `🔍 [RAG] "${pergunta}" → ${linhas.length} candidatos, top: ${
        linhas[0]?.similaridade?.toFixed(3) ?? 'n/a'
      }`,
    );
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
// [FIX] LLM-judge — valida se a resposta associa sintoma
// do usuário a doença. Aceita explicação educativa.
// ────────────────────────────────────────────────────
const JUDGE_SYSTEM = `Você analisa respostas de um assistente do SUS.

Pergunta-chave: a resposta proposta sugere que o USUÁRIO TEM alguma doença específica,
ou associa os sintomas relatados por ele a um diagnóstico?

Exemplos:
- "Dengue é transmitida por mosquito" → NAO (explicação educativa)
- "Você pode estar com dengue" → SIM
- "Seus sintomas são típicos de gripe" → SIM
- "Febre acima de 39°C merece atenção" → NAO (info geral)
- "Quadro de gripe costuma durar 7 dias" → SIM
- "Recomendo tomar dipirona" → SIM

Responda APENAS: SIM ou NAO.`;

async function respostaTemDiagnostico(pergunta: string, resposta: string): Promise<boolean> {
  try {
    const prompt = `Pergunta: "${pergunta}"\n\nResposta proposta: "${resposta}"`;
    const saida = await gerarTexto(prompt, JUDGE_SYSTEM, 5);
    const limpo = (saida ?? '').trim().toUpperCase();
    return limpo.startsWith('SIM');
  } catch (err: any) {
    console.error(`❌ [RAG/judge] falha:`, err?.message || err);
    // Em caso de falha do judge, conservador: bloqueia (prefere perder resposta
    // do que arriscar diagnóstico).
    return true;
  }
}

// ────────────────────────────────────────────────────
// Texto seguro quando o judge reprova
// ────────────────────────────────────────────────────
function respostaSeguraGenerica(): string {
  return (
    'Para sintomas como os que você descreveu, o ideal é procurar uma UBS para avaliação. ' +
    'Se for urgente (falta de ar, dor no peito, desmaio ou confusão), procure uma UPA 24h ou ligue 192 (SAMU).'
  );
}

// ────────────────────────────────────────────────────
// System prompt do RAG — proíbe diagnóstico explicitamente
// ────────────────────────────────────────────────────
const RAG_SYSTEM = `Você é um assistente do SUS que explica informações GERAIS sobre saúde e serviços públicos.

REGRAS ABSOLUTAS:
1. NUNCA diga o que a pessoa "pode ter", "parece ser", "é compatível com" ou "pode indicar".
2. NUNCA use sintomas que a pessoa relatou para sugerir uma doença específica.
3. NUNCA recomende medicamentos, doses ou tratamentos.
4. Ao explicar uma doença (ex: "o que é dengue"), explique transmissão, sinais gerais e
   prevenção — NUNCA diga que os sintomas do usuário batem com ela.

O QUE VOCÊ PODE FAZER:
- Explicar informações gerais (ex: "febre é temperatura acima de 37,8°C").
- Explicar diferenças entre serviços do SUS (UBS, UPA, SAMU, CAPS).
- Orientar quando procurar cada serviço.

FORMATO:
- Português claro, acolhedor, direto. Máximo 3 parágrafos.
- Se a base não tiver a informação, devolva EXATAMENTE: NAO_ENCONTRADO

Exemplo BOM: "Febre é temperatura acima de 37,8°C. Se durar mais de 3 dias ou vier com
falta de ar, procure uma UPA."
Exemplo RUIM: "Seus sintomas podem ser de gripe."`;

// ────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────
export async function responderDaBase(
  pergunta: string,
): Promise<RespostaEstruturada | null> {
  let contextoTexto = '';
  let topicoBase: { id: string; titulo: string; conteudo: string; similaridade?: number } | null = null;
  let origem: RespostaEstruturada['origem'] = 'vetorial';

  const candidatosVetoriais = await buscarTopK(pergunta, 5);

  if (candidatosVetoriais.length > 0) {
    contextoTexto = candidatosVetoriais.map((t) => `### ${t.titulo}\n${t.conteudo}`).join('\n\n---\n\n');
    topicoBase = candidatosVetoriais[0];
    console.log(`✅ [RAG] usando ${candidatosVetoriais.length} tópicos vetoriais`);
  } else {
    const candidatosLocais = buscarLocalKeyword(pergunta, 3);
    if (candidatosLocais.length === 0) {
      console.log(`❌ [RAG] sem tópicos para "${pergunta}"`);
      return null;
    }
    contextoTexto = candidatosLocais.map((t) => `### ${t.titulo}\n${t.conteudo}`).join('\n\n---\n\n');
    topicoBase = candidatosLocais[0];
    origem = 'keyword';
    console.log(`🔄 [RAG] usando fallback keyword: ${candidatosLocais.length} tópicos`);
  }

  const prompt = `PERGUNTA DO USUÁRIO:\n"${pergunta}"\n\nBASE DE CONHECIMENTO (use SOMENTE isto):\n${contextoTexto}`;
  const texto = await gerarTexto(prompt, RAG_SYSTEM, 20000);

  // ── Fallback: LLM não respondeu → usa tópico curado direto (já é seguro)
  if (!texto || texto === 'NAO_ENCONTRADO' || texto.includes('NAO_ENCONTRADO') || texto.length < 20) {
    console.log(`⚠️ [RAG] resposta insuficiente, usando tópico direto`);
    if (!topicoBase) return null;
    const paragrafos = topicoBase.conteudo.split('\n\n').filter(Boolean);
    return {
      titulo: topicoBase.titulo,
      corpo: paragrafos.slice(0, 2).join('\n\n'),
      topico_id: topicoBase.id,
      origem: 'fallback_direto',
    };
  }

  // ── [FIX estrutural] Judge antes de devolver
  const suspeito = await respostaTemDiagnostico(pergunta, texto);
  if (suspeito) {
    console.warn(`🚫 [RAG/judge] bloqueado: "${texto.slice(0, 80)}..."`);
    return {
      titulo: '',
      corpo: respostaSeguraGenerica(),
      topico_id: topicoBase?.id ?? 'seguro_generico',
      origem,
      bloqueado: true,
    };
  }

  console.log(`✅ [RAG] resposta aprovada pelo judge (${texto.length} chars)`);
  return {
    titulo: topicoBase?.titulo ?? '',
    corpo: texto,
    topico_id: topicoBase?.id ?? 'desconhecido',
    origem,
    similaridade: topicoBase?.similaridade,
  };
}

export async function temTopicoRelevante(pergunta: string): Promise<boolean> {
  const vetoriais = await buscarTopK(pergunta, 1);
  if (vetoriais.length > 0) return true;
  return buscarLocalKeyword(pergunta, 1).length > 0;
}