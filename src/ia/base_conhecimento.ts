// src/ia/base_conhecimento.ts
// RAG com cache em memória (TTL 1h) e judge condicional (só clínico).

import type { Sql } from '../whatsapp/persistencia_sessao.js';
import { gerarEmbedding } from '../servicos/embeddings.js';
import { gerarTexto } from '../servicos/ia.js';
import { normalizarTexto } from './normalizar.js';
import baseLocal from '../regras/base_conhecimento.json';

let sqlCliente: Sql | null = null;
export function registrarClienteDb(sql: Sql | null): void {
  sqlCliente = sql;
  console.log(`📌 [RAG] cliente DB ${sql ? 'registrado' : 'NULO'}`);
}

export type RespostaEstruturada = {
  titulo: string;
  corpo: string;
  topico_id: string;
  origem: 'vetorial' | 'keyword' | 'fallback_direto' | 'cache';
  similaridade?: number;
  bloqueado?: boolean;
};

// ────────────────────────────────────────────────────
// CACHE — TTL 1h, limite 500 entradas
// ────────────────────────────────────────────────────
type CacheEntry = { resposta: RespostaEstruturada | null; expiraEm: number };
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cacheRAG = new Map<string, CacheEntry>();

function chaveCache(pergunta: string): string {
  return normalizarTexto(pergunta).slice(0, 200);
}

function getCache(chave: string): CacheEntry | null {
  const e = cacheRAG.get(chave);
  if (!e) return null;
  if (Date.now() > e.expiraEm) {
    cacheRAG.delete(chave);
    return null;
  }
  return e;
}

function setCache(chave: string, resposta: RespostaEstruturada | null): void {
  if (cacheRAG.size >= CACHE_MAX) {
    let maisAntigo = '';
    let menorTs = Infinity;
    for (const [k, v] of cacheRAG.entries()) {
      if (v.expiraEm < menorTs) { menorTs = v.expiraEm; maisAntigo = k; }
    }
    if (maisAntigo) cacheRAG.delete(maisAntigo);
  }
  cacheRAG.set(chave, { resposta, expiraEm: Date.now() + CACHE_TTL_MS });
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
// JUDGE CONDICIONAL — só roda pra tópicos clínicos
// ────────────────────────────────────────────────────
const PREFIXOS_SERVICO = [
  'o_que_e_sus', 'como_', 'conecte_', 'farmacia_', 'medicamento_uso',
  'ouvidoria', 'direitos_', 'agente_', 'estrategia_', 'nasf', 'melhor_',
  'academia_', 'vigilancia_', 'vacinas_', 'vacina', 'doacao_', 'transplante_',
  'pre_natal_detalhado', 'amamentacao_dificuldades', 'saude_idoso', 'saude_deficiente',
  'saude_indigena', 'atendimento_domiciliar', 'cuidados_paliativos', 'ciatox',
  'regulacao_', 'notificacao_', 'violencia_contra', 'violencia_idoso',
  'gravidez_adolescencia', 'hiv_tratamento', 'caps_', 'atendimento_psi',
  'como_conseguir', 'tempo_espera', 'saude_mental_atendimento',
  'saude_do_homem', 'saude_da_mulher', 'planejamento_familiar',
];

function ehTopicoServico(id: string): boolean {
  return PREFIXOS_SERVICO.some((p) => id.startsWith(p)) ||
    id === 'cartao_sus' || id === 'saude_bucal' || id === 'vacinacao' ||
    id === 'aleitamento' || id === 'diferenca_ubs_upa_samu';
}

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
    return true;
  }
}

function respostaSeguraGenerica(): string {
  return (
    'Para sintomas como os que você descreveu, o ideal é procurar uma UBS para avaliação. ' +
    'Se for urgente (falta de ar, dor no peito, desmaio ou confusão), procure uma UPA 24h ou ligue 192 (SAMU).'
  );
}

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

O QUE VOCÊ PODE FAZER:
- Explicar informações gerais (ex: "febre é temperatura acima de 38°C").
- Explicar diferenças entre serviços do SUS (UBS, UPA, SAMU, CAPS).
- Orientar quando procurar cada serviço.

Se a base não tiver a informação, devolva EXATAMENTE: NAO_ENCONTRADO`;

const DOENCAS_DIAGNOSTICAS =
  'gripe|influenza|dengue|zika|chikungunya|covid|coronavirus|pneumonia|infarto|avc|derrame|meningite|apendicite|cancer|gastrite|sinusite|amigdalite|bronquite|asma|hepatite|tuberculose|hanseniase';

function respostaDiagnosticaRegex(resposta: string): boolean {
  const padroes = [
    /\b(voc[eê]|o senhor|a senhora)\b[^.!?]{0,40}\b(pode|deve|parece|provavelmente|possivelmente)\b[^.!?]{0,30}\b(ter|estar com|ser)\b/i,
    /\b(seus?|os)\s+sintomas?\b[^.!?]{0,40}\b(s[aã]o|indicam|sugerem|apontam|revelam|batem com|cursam com)\b/i,
    new RegExp(`\\b(isso|isto|esse quadro|esse caso)\\b[^.!?]{0,30}\\b(é|eh|pode ser|deve ser|parece)\\b[^.!?]{0,20}\\b(${DOENCAS_DIAGNOSTICAS})\\b`, 'i'),
    new RegExp(`\\b(quadro|caso|suspeita)\\s+de\\s+(${DOENCAS_DIAGNOSTICAS})\\b`, 'i'),
    /\b(diagn[oó]stico|progn[oó]stico)\b[^.!?]{0,30}\b(é|eh|prov[aá]vel|sugere|indica)\b/i,
    new RegExp(`\\b(provavelmente|possivelmente|aparentemente|talvez)\\b[^.!?]{0,30}\\b(${DOENCAS_DIAGNOSTICAS})\\b`, 'i'),
  ];
  for (const p of padroes) if (p.test(resposta)) return true;
  return false;
}

export async function responderDaBase(
  pergunta: string,
  historicoFormatado?: string,
): Promise<RespostaEstruturada | null> {
  const chave = chaveCache(pergunta);
  const cacheado = getCache(chave);
  if (cacheado) {
    console.log(`⚡ [RAG/cache] hit para "${pergunta.slice(0, 40)}"`);
    return cacheado.resposta ? { ...cacheado.resposta, origem: 'cache' } : null;
  }

  let contextoTexto = '';
  let topicoBase: { id: string; titulo: string; conteudo: string; similaridade?: number } | null = null;
  let origem: RespostaEstruturada['origem'] = 'vetorial';

  const candidatosVetoriais = await buscarTopK(pergunta, 5);

  if (candidatosVetoriais.length > 0) {
    contextoTexto = candidatosVetoriais.map((t) => `### ${t.titulo}\n${t.conteudo}`).join('\n\n---\n\n');
    topicoBase = candidatosVetoriais[0];
  } else {
    const candidatosLocais = buscarLocalKeyword(pergunta, 3);
    if (candidatosLocais.length === 0) {
      console.log(`❌ [RAG] sem tópicos para "${pergunta}"`);
      setCache(chave, null);
      return null;
    }
    contextoTexto = candidatosLocais.map((t) => `### ${t.titulo}\n${t.conteudo}`).join('\n\n---\n\n');
    topicoBase = candidatosLocais[0];
    origem = 'keyword';
    console.log(`🔄 [RAG] fallback keyword: ${candidatosLocais.length} tópicos`);
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
    if (!topicoBase) { setCache(chave, null); return null; }
    const paragrafos = topicoBase.conteudo.split('\n\n').filter(Boolean);
    const resposta: RespostaEstruturada = {
      titulo: topicoBase.titulo,
      corpo: paragrafos.slice(0, 2).join('\n\n'),
      topico_id: topicoBase.id,
      origem: 'fallback_direto',
    };
    setCache(chave, resposta);
    return resposta;
  }

  let textoFinal = texto;
  if (texto.length > 800 && pergunta.length < 80) {
    const paragrafos = texto.split(/\n\n+/);
    textoFinal = paragrafos.slice(0, 3).join('\n\n');
  }

  if (respostaDiagnosticaRegex(textoFinal)) {
    console.warn(`🚫 [RAG/regex] bloqueado`);
    const resposta: RespostaEstruturada = {
      titulo: '',
      corpo: respostaSeguraGenerica(),
      topico_id: topicoBase?.id ?? 'seguro_generico',
      origem,
      bloqueado: true,
    };
    setCache(chave, resposta);
    return resposta;
  }

  const topicoId = topicoBase?.id ?? '';
  if (!ehTopicoServico(topicoId)) {
    const suspeito = await respostaTemDiagnostico(pergunta, textoFinal);
    if (suspeito) {
      console.warn(`🚫 [RAG/judge] bloqueado`);
      const resposta: RespostaEstruturada = {
        titulo: '',
        corpo: respostaSeguraGenerica(),
        topico_id: topicoId || 'seguro_generico',
        origem,
        bloqueado: true,
      };
      setCache(chave, resposta);
      return resposta;
    }
  } else {
    console.log(`⏭️ [RAG/judge] pulado — tópico de serviço: ${topicoId}`);
  }

  const resposta: RespostaEstruturada = {
    titulo: topicoBase?.titulo ?? '',
    corpo: textoFinal,
    topico_id: topicoId || 'desconhecido',
    origem,
    similaridade: topicoBase?.similaridade,
  };
  setCache(chave, resposta);
  return resposta;
}

export async function temTopicoRelevante(pergunta: string): Promise<boolean> {
  const vetoriais = await buscarTopK(pergunta, 1);
  if (vetoriais.length > 0) return true;
  return buscarLocalKeyword(pergunta, 1).length > 0;
}