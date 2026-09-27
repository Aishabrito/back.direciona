// src/ia/base_conhecimento.ts
// RAG: busca vetorial (semântica) + resposta via Groq.
// Devolve estrutura + passa por 2 camadas anti-diagnóstico antes de sair.

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
// Tipo público
// ────────────────────────────────────────────────────
export type RespostaEstruturada = {
  titulo: string;
  corpo: string;
  topico_id: string;
  origem: 'vetorial' | 'keyword' | 'fallback_direto';
  similaridade?: number;
  bloqueado?: boolean;
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
// LLM-judge (Camada 3 — semântica)
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
    const saida = await gerarTexto(prompt, JUDGE_SYSTEM);
    const limpo = (saida ?? '').trim().toUpperCase();
    return limpo.startsWith('SIM');
  } catch (err: any) {
    console.error(`❌ [RAG/judge] falha:`, err?.message || err);
    return true; // conservador
  }
}

function respostaSeguraGenerica(): string {
  return (
    'Para sintomas como os que você descreveu, o ideal é procurar uma UBS para avaliação. ' +
    'Se for urgente (falta de ar, dor no peito, desmaio ou confusão), procure uma UPA 24h ou ligue 192 (SAMU).'
  );
}

// ────────────────────────────────────────────────────
// System prompt do RAG — CONCISO
// ────────────────────────────────────────────────────
const RAG_SYSTEM = `Você é um assistente do SUS que explica informações GERAIS sobre saúde e serviços públicos.

REGRAS ABSOLUTAS:
1. NUNCA diga o que a pessoa "pode ter", "parece ser", "é compatível com" ou "pode indicar".
2. NUNCA use sintomas que a pessoa relatou para sugerir uma doença específica.
3. NUNCA recomende medicamentos, doses ou tratamentos.
4. Ao explicar uma doença (ex: "o que é dengue"), explique transmissão, sinais gerais e
   prevenção — NUNCA diga que os sintomas do usuário batem com ela.

ESTILO — MUITO IMPORTANTE:
- Responda SÓ o que foi perguntado. Se a pergunta é "quantos graus é febre?",
  responda em 1-2 frases com a temperatura e quando procurar ajuda. NÃO copie o tópico inteiro.
- Se a pergunta é específica, seja específico. Se é ampla, aí sim dê um panorama curto.
- Máximo 3 parágrafos curtos. Ideal: 1-2 frases quando der.
- NUNCA repita o título ou o texto bruto do tópico. Sintetize.
- Não cumprimente ("Olá!"), não se apresente, não encerre com "espero ter ajudado".
- Vá direto ao ponto.

Exemplo BOM (pergunta "quantos graus é febre?"):
"Febre é a partir de ~38°C. Em adultos, procure uma UPA se passar de 39°C, durar mais de 3 dias ou vier com falta de ar, manchas ou confusão."

Exemplo RUIM:
"Olá! A febre é o aumento da temperatura corporal, geralmente considerada a partir de aproximadamente 38°C... [3 parágrafos gigantes repetindo tudo]"

O QUE VOCÊ PODE FAZER:
- Explicar informações gerais (ex: "febre é temperatura acima de 38°C").
- Explicar diferenças entre serviços do SUS (UBS, UPA, SAMU, CAPS).
- Orientar quando procurar cada serviço.

Se a base não tiver a informação, devolva EXATAMENTE: NAO_ENCONTRADO`;

// ────────────────────────────────────────────────────
// [CAMADA 5] Filtro determinístico anti-diagnóstico.
// Rede de segurança caso o LLM-judge falhe.
// Não bloqueia explicação educativa ("dengue é transmitida por...").
// Bloqueia associação sintoma ↔ doença ("seus sintomas são de X").
// ────────────────────────────────────────────────────
const DOENCAS_DIAGNOSTICAS =
  'gripe|influenza|dengue|zika|chikungunya|covid|coronavirus|pneumonia|infarto|avc|derrame|meningite|apendicite|cancer|gastrite|sinusite|amigdalite|bronquite|asma|hepatite|tuberculose|hanseniase';

function respostaDiagnosticaRegex(resposta: string): boolean {
  const padroes = [
    // "você pode estar com X", "você tem X"
    /\b(voc[eê]|o senhor|a senhora)\b[^.!?]{0,40}\b(pode|deve|parece|provavelmente|possivelmente)\b[^.!?]{0,30}\b(ter|estar com|ser)\b/i,
    // "seus sintomas são de X" / "seus sintomas indicam X"
    /\b(seus?|os)\s+sintomas?\b[^.!?]{0,40}\b(s[aã]o|indicam|sugerem|apontam|revelam|batem com|cursam com)\b/i,
    // "isso é X" / "isso pode ser X" com doença
    new RegExp(`\\b(isso|isto|esse quadro|esse caso)\\b[^.!?]{0,30}\\b(é|eh|pode ser|deve ser|parece)\\b[^.!?]{0,20}\\b(${DOENCAS_DIAGNOSTICAS})\\b`, 'i'),
    // "quadro de X" / "caso de X" (quando ligado ao usuário)
    new RegExp(`\\b(quadro|caso|suspeita)\\s+de\\s+(${DOENCAS_DIAGNOSTICAS})\\b`, 'i'),
    // "o diagnóstico é", "diagnóstico provável"
    /\b(diagn[oó]stico|progn[oó]stico)\b[^.!?]{0,30}\b(é|eh|prov[aá]vel|sugere|indica)\b/i,
    // "provavelmente é X", "possivelmente é X" + doença
    new RegExp(`\\b(provavelmente|possivelmente|aparentemente|talvez)\\b[^.!?]{0,30}\\b(${DOENCAS_DIAGNOSTICAS})\\b`, 'i'),
  ];

  for (const p of padroes) {
    if (p.test(resposta)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────
export async function responderDaBase(
  pergunta: string,
  historicoFormatado?: string,
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

  const prompt = `PERGUNTA DO USUÁRIO:
"${pergunta}"

${
  historicoFormatado
    ? `CONTEXTO DA CONVERSA (use APENAS para desambiguar a pergunta):\n${historicoFormatado}\n\n---\n\n`
    : ''
}BASE DE CONHECIMENTO (use SOMENTE isto):
${contextoTexto}`;

  const texto = await gerarTexto(prompt, RAG_SYSTEM, 20000);

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

  // [FIX] Corte de tamanho — pergunta curta não merece resposta gigante
  let textoFinal = texto;
  if (texto.length > 800 && pergunta.length < 80) {
    const paragrafos = texto.split(/\n\n+/);
    textoFinal = paragrafos.slice(0, 3).join('\n\n');
    console.log(`✂️ [RAG] resposta cortada: ${texto.length} → ${textoFinal.length} chars`);
  }

  // ── [CAMADA 5] Regex determinístico — ANTES do LLM judge
  // É rápido, não depende do LLM e pega os casos óbvios.
  if (respostaDiagnosticaRegex(textoFinal)) {
    console.warn(`🚫 [RAG/regex] bloqueado: "${textoFinal.slice(0, 80)}..."`);
    return {
      titulo: '',
      corpo: respostaSeguraGenerica(),
      topico_id: topicoBase?.id ?? 'seguro_generico',
      origem,
      bloqueado: true,
    };
  }

  // ── [CAMADA 3] LLM-judge — pega o que o regex deixou passar
  const suspeito = await respostaTemDiagnostico(pergunta, textoFinal);
  if (suspeito) {
    console.warn(`🚫 [RAG/judge] bloqueado: "${textoFinal.slice(0, 80)}..."`);
    return {
      titulo: '',
      corpo: respostaSeguraGenerica(),
      topico_id: topicoBase?.id ?? 'seguro_generico',
      origem,
      bloqueado: true,
    };
  }

  console.log(`✅ [RAG] resposta aprovada pelas 2 camadas (${textoFinal.length} chars)`);
  return {
    titulo: topicoBase?.titulo ?? '',
    corpo: textoFinal,
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