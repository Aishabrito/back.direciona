// src/servicos/ia.ts
// Camada de abstração para o Groq (texto). Usa SDK oficial da OpenAI
// com baseURL apontando pro Groq.

import OpenAI from 'openai';

export const GROQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

// [FIX] Lazy init — só cria o cliente quando for de fato usar.
// Sem isso, importar este módulo em ambiente de teste (sem GROQ_API_KEY)
// explode com "Missing credentials" na hora do import.
let _groq: OpenAI | null = null;

function getGroq(): OpenAI | null {
  if (_groq) return _groq;
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  _groq = new OpenAI({
    apiKey: key,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  return _groq;
}

export type JsonSchema = {
  name: string;
  schema: Record<string, any>;
  strict?: boolean;
};

export async function gerarTexto(
  prompt: string,
  systemInstruction?: string,
  timeoutMs = 20000,
  maxTokens?: number,
): Promise<string | null> {
  const groq = getGroq();
  if (!groq) {
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
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
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

export async function gerarJSON<T = any>(
  prompt: string,
  systemInstruction: string,
  timeoutMs = 20000,
  jsonSchema?: JsonSchema,
): Promise<T | null> {
  const groq = getGroq();
  if (!groq) {
    console.warn('⚠️ [IA] GROQ_API_KEY ausente. Chamando sem LLM.');
    return null;
  }

  // ── 1. Tenta com schema fechado
  if (jsonSchema) {
    try {
      const promessa = groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          { role: 'system' as const, content: systemInstruction },
          { role: 'user' as const, content: prompt },
        ],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: jsonSchema.name,
            schema: jsonSchema.schema,
            strict: jsonSchema.strict ?? true,
          },
        },
      } as any);

      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout groq')), timeoutMs),
      );
      const resp = await Promise.race([promessa, timeout]);
      const texto = resp.choices[0]?.message?.content?.trim() ?? '';
      if (!texto) return null;
      return JSON.parse(texto) as T;
    } catch (err: any) {
      const msg = err?.message || String(err);
      const naoSuportado =
        /json_schema|response_format|structured|unsupported|invalid.*format/i.test(msg);
      if (naoSuportado) {
        console.warn('⚠️ [IA] json_schema não suportado, caindo pra json_object:', msg);
      } else {
        console.error('❌ [IA] json_schema falhou:', msg);
        return null;
      }
    }
  }

  // ── 2. Fallback: json_object
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