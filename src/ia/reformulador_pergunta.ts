
import { GoogleGenAI } from '@google/genai';
import { normalizarTexto } from './normalizar.js';

const TERMOS_PROIBIDOS_REFORM =
  /\b(remedio|medicamento|comprimido|antibiotico|diagnostico|infarto|avc|doenca|dose|mg|ml)\b/i;

export async function reformularPergunta(
  perguntaFixa: string,
  contexto: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return perguntaFixa;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const promessa = ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Reformule a pergunta abaixo em UMA frase curta, acolhedora e natural, para WhatsApp.
CONTEXTO DO PACIENTE: ${contexto}
PERGUNTA ORIGINAL: ${perguntaFixa}

REGRAS:
- Não dê diagnóstico, não sugira remédio, não prescreva.
- Não invente informação clínica.
- Mantenha o mesmo sentido da pergunta.
- Devolva apenas a frase reformulada.`,
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout reform')), 5000),
    );
    const resp = (await Promise.race([promessa, timeout])) as any;
    const texto = (resp.text || '').trim();

    if (!texto || texto.length > 300) return perguntaFixa;
    if (TERMOS_PROIBIDOS_REFORM.test(normalizarTexto(texto))) return perguntaFixa;
    if (!texto.endsWith('?')) return perguntaFixa;

    return texto;
  } catch {
    return perguntaFixa;
  }
}