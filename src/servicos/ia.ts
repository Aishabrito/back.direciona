// src/servicos/ia.ts
// Camada de abstração para o Groq (texto). Usa SDK oficial da OpenAI
// com baseURL apontando pro Groq.

import OpenAI from 'openai';

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

export const GROQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

/**
 * Gera uma resposta em texto livre (uso: reformular pergunta, responder RAG).
 * Devolve null se Groq não estiver configurado ou falhar.
 */
export async function gerarTexto(
  prompt: string,
  systemInstruction?: string,
  timeoutMs = 20000,
): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️ [IA] GROQ_API_KEY ausente. Chamando sem LLM.');
    return null;
  }

  try {
    const promessa = groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        ...(systemInstruction
          ? [{ role: 'system' as const, content: systemInstruction }]
          : []),
        { role: 'user' as const, content: prompt },
      ],
      temperature: 0,
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout groq')), timeoutMs),
    );
    const resp = await Promise.race([promessa, timeout]);
    const texto = resp.choices[0]?.message?.content?.trim() ?? '';
    return texto || null;
  } catch (err: any) {
    console.error('❌ [IA] Groq falhou:', err?.message || err);
    return null;
  }
}

/**
 * Gera resposta em JSON (uso: extração estruturada).
 * Devolve null se falhar.
 */
export async function gerarJSON<T = any>(
  prompt: string,
  systemInstruction: string,
  timeoutMs = 20000,
): Promise<T | null> {
  if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️ [IA] GROQ_API_KEY ausente. Chamando sem LLM.');
    return null;
  }

  try {
    const promessa = groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: 'system' as const, content: systemInstruction },
        { role: 'user' as const, content: prompt },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout groq')), timeoutMs),
    );
    const resp = await Promise.race([promessa, timeout]);
    const texto = resp.choices[0]?.message?.content?.trim() ?? '';
    if (!texto) return null;
    return JSON.parse(texto) as T;
  } catch (err: any) {
    console.error('❌ [IA] Groq (JSON) falhou:', err?.message || err);
    return null;
  }
}