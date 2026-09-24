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
// Resposta direta (fallback se LLM falha)
// ────────────────────────────────────────────────────
function montarRespostaDireta(topico: { titulo: string; conteudo: string }): string {
  const paragrafos = topico.conteudo.split('\n\n').filter(Boolean);
  const trecho = paragrafos.slice(0, 2).join('\n\n');
  return `*${topico.titulo}*\n\n${trecho}`;
}

// ────────────────────────────────────────────────────
// [FIX] Filtro de segurança — detecta diagnóstico disfarçado
// sem bloquear conteúdo educativo ("o que é dengue").
// ────────────────────────────────────────────────────
function detectarDiagnostico(texto: string): string | null {
  const padroes: Array<{ nome: string; re: RegExp }> = [
    {
      nome: 'associacao_sintoma_doenca',
      re: /\b(voc[eê]|seus?\s+sintomas?|isso|esse\s+quadro|esse\s+caso)\b[^.!?]{0,60}\b(pode|pode ser|deve ser|parece|sugere|indica|é compat[íi]vel|compat[íi]vel)\b[^.!?]{0,40}\b(gripe|influenza|dengue|covid|pneumonia|infarto|avc|derrame|meningite|apendicite|cancer|c[aâ]ncer)\b/i,
    },
    {
      nome: 'suspeita_explicita',
      re: /\b(parece|provavelmente|possivelmente|talvez)\b[^.!?]{0,30}\b(gripe|influenza|dengue|covid|pneumonia|infarto|avc|meningite)\b/i,
    },
    {
      nome: 'quadro_de',
      re: /\b(quadro\s+de|caso\s+de|suspeita\s+de|compat[íi]vel\s+com)\b[^.!?]{0,30}\b(gripe|influenza|dengue|covid|pneumonia|infarto|avc|meningite|apendicite)\b/i,
    },
    {
      nome: 'recomendacao_medicamento',
      re: /\b(tome|tomar|beba|beber|use|usar)\b[^.!?]{0,30}\b(dipirona|paracetamol|ibuprofeno|amoxicilina|rem[eé]dio|medicamento|antibi[oó]tico)\b/i,
    },
  ];
  for (const p of padroes) if (p.re.test(texto)) return p.nome;
  return null;
}

// ────────────────────────────────────────────────────
// [FIX] Resposta segura quando o filtro bloqueia
// ────────────────────────────────────────────────────
function respostaSeguraGenerica(): string {
  return (
    'Para saber onde buscar atendimento, me conte o que você está sentindo e há quanto tempo. ' +
    'Se for falta de ar, dor no peito, desmaio ou confusão mental, procure uma UPA 24h ou ligue 192 (SAMU). ' +
    'Para sintomas mais leves e persistentes, uma UBS resolve.'
  );
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

  // [FIX] Proibir diagnóstico explicitamente. O prompt antigo
  // ("agente do SUS explicando") deixava brecha pro LLM nomear doença.
  const systemInstruction = `Você é um assistente do SUS que explica informações GERAIS sobre saúde e serviços públicos.

REGRAS ABSOLUTAS — NUNCA QUEBRE NENHUMA:
1. NUNCA diga o que a pessoa "pode ter", "parece ser", "é compatível com" ou "pode indicar".
2. NUNCA use sintomas que a pessoa relatou para sugerir uma doença específica.
3. NUNCA recomende medicamentos, doses, tratamentos ou remédios caseiros.
4. NUNCA dê orientação clínica personalizada.
5. Ao explicar uma doença (ex: "o que é dengue"), explique transmissão, sinais gerais e prevenção — NUNCA diga que os sintomas do usuário batem com ela.

O QUE VOCÊ PODE FAZER:
- Explicar informações gerais (ex: "febre é temperatura acima de 37,8°C").
- Explicar diferenças entre serviços do SUS (UBS, UPA, SAMU, CAPS, maternidade).
- Orientar de forma geral quando procurar cada serviço.
- Ensinar sinais de alarme em termos gerais ("procure ajuda se a febre durar mais de 3 dias").

FORMATO:
- Português claro, acolhedor, direto. Máximo 3 parágrafos.
- Se a pergunta não puder ser respondida dentro dessas regras, devolva EXATAMENTE a string NAO_ENCONTRADO.

Exemplo BOM: "Febre é temperatura acima de 37,8°C. Se durar mais de 3 dias ou vier com falta de ar, procure uma UPA."
Exemplo RUIM (NUNCA): "Seus sintomas podem ser de gripe. Beba bastante líquido."

Se a base não tiver a informação suficiente, devolva EXATAMENTE NAO_ENCONTRADO.`;

  const texto = await gerarTexto(prompt, systemInstruction, 20000);

  if (!texto || texto === 'NAO_ENCONTRADO' || texto.includes('NAO_ENCONTRADO')) {
    console.log(`⚠️ [RAG] Groq sem resposta, usando tópico direto`);
    return primeiroTopico ? montarRespostaDireta(primeiroTopico) : null;
  }
  if (texto.length < 20) {
    console.log(`⚠️ [RAG] resposta curta, usando tópico direto`);
    return primeiroTopico ? montarRespostaDireta(primeiroTopico) : null;
  }

  // [FIX] Filtro contextualizado: bloqueia associação diagnóstico ↔ usuário,
  // mas NÃO bloqueia explicação educativa ("o que é dengue").
  const violacao = detectarDiagnostico(texto);
  if (violacao) {
    console.warn(`🚫 [RAG] bloqueado por "${violacao}": "${texto.slice(0, 80)}..."`);
    return respostaSeguraGenerica();
  }

  console.log(`✅ [RAG] resposta gerada pelo Groq (${texto.length} chars)`);
  return texto;
}

export async function temTopicoRelevante(pergunta: string): Promise<boolean> {
  const vetoriais = await buscarTopK(pergunta, 1);
  if (vetoriais.length > 0) return true;
  return buscarLocalKeyword(pergunta, 1).length > 0;
}