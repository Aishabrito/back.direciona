
import { GoogleGenAI } from '@google/genai';
const MODELO = 'gemini-embedding-001';

export async function gerarEmbedding(texto: string): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GEMINI_API_KEY ausente. Embedding indisponível.');
    return null;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const resp = await ai.models.embedContent({
  model: MODELO,
  contents: texto.slice(0, 2000),
  config: { outputDimensionality: 768 },
});

    const valores = (resp as any)?.embeddings?.[0]?.values;
    if (!Array.isArray(valores) || valores.length === 0) {
      console.error('❌ Embedding vazio');
      return null;
    }
    return valores as number[];
  } catch (err) {
    console.error('❌ Embedding falhou:', err);
    return null;
  }
}