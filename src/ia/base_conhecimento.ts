
import { GoogleGenAI } from '@google/genai';
import { normalizarTexto, contemAlgum } from './normalizar.js';
import baseDados from '../regras/base_conhecimento.json';

type Topico = {
  id: string;
  titulo: string;
  tags: string[];
  conteudo: string;
};

const TOPICOS = (baseDados as { topicos: Topico[] }).topicos;

function tokenizar(texto: string): string[] {
  return normalizarTexto(texto)
    .split(/\s+/)
    .filter((p) => p.length > 2);
}

// Score simples: quantas tags/título do tópico casam com as palavras da pergunta
function pontuarTopico(pergunta: string, topico: Topico): number {
  const tokensPergunta = tokenizar(pergunta);
  const textoTopico = normalizarTexto(
    `${topico.titulo} ${topico.tags.join(' ')} ${topico.conteudo}`,
  );
  let acertos = 0;
  for (const t of tokensPergunta) {
    if (textoTopico.includes(t)) acertos++;
  }
  return acertos;
}

function prefiltrar(pergunta: string, limite = 5): Topico[] {
  const ranqueados = TOPICOS
    .map((t) => ({ topico: t, score: pontuarTopico(pergunta, t) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limite);
  return ranqueados.map((x) => x.topico);
}

/**
 * Responde uma pergunta de saúde com base na base de conhecimento.
 * Retorna null se nada relevante for encontrado ou se a resposta for vazia.
 */
export async function responderDaBase(
  pergunta: string,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const candidatos = prefiltrar(pergunta);
  if (candidatos.length === 0) return null;

  const contexto = candidatos
    .map((t) => `### ${t.titulo}\n${t.conteudo}`)
    .join('\n\n---\n\n');

  try {
    const ai = new GoogleGenAI({ apiKey });
    const promessa = ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `PERGUNTA DO USUÁRIO:
"${pergunta}"

BASE DE CONHECIMENTO (use SOMENTE isto):
${contexto}

Responda à pergunta em português, de forma clara e acolhedora, como se fosse um agente do SUS explicando para um usuário comum. Se a base não tiver a informação para responder, devolva EXATAMENTE a string NAO_ENCONTRADO e nada mais.`,
      config: {
        temperature: 0,
      },
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout base')), 8000),
    );
    const resp = (await Promise.race([promessa, timeout])) as any;
    const texto = (resp.text || '').trim();

    if (!texto || texto === 'NAO_ENCONTRADO' || texto.includes('NAO_ENCONTRADO')) {
      return null;
    }
    if (texto.length < 20) return null;
    return texto;
  } catch (err) {
    console.error('❌ Base de conhecimento falhou:', err);
    return null;
  }
}

// Para os testes ou para checar se vale a pena chamar
export function temTopicoRelevante(pergunta: string): boolean {
  return prefiltrar(pergunta).length > 0;
}