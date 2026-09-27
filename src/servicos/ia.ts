// src/servicos/ia.ts
// Camada de abstração para o Groq (texto). Usa SDK oficial da OpenAI
// com baseURL apontando pro Groq.

import OpenAI from 'openai';

export const GROQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

// Lazy init — só cria o cliente quando for de fato usar.
// Sem isso, importar este módulo sem GROQ_API_KEY explode com "Missing credentials".
let _groq: OpenAI | null = null;

export function getGroq(): OpenAI | null {
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

export type UsoLLM = { tokens_in: number; tokens_out: number };

export type RespostaJSON<T> = { dados: T; uso: UsoLLM };

// Se o modelo não suporta json_schema, lembra disso e não tenta de novo
// (evita pagar 1 chamada com erro em todo turno).
let jsonSchemaSuportado = true;

function comTimeout<T>(p: Promise<T>, ms: number, rotulo: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout ${rotulo}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function lerUso(resp: any): UsoLLM {
  return {
    tokens_in: resp?.usage?.prompt_tokens ?? 0,
    tokens_out: resp?.usage?.completion_tokens ?? 0,
  };
}

/**
 * Chama o LLM pedindo JSON. Tenta json_schema (saída fechada) e cai pra
 * json_object se o modelo não suportar. Devolve null em qualquer falha —
 * quem chama SEMPRE precisa ter um caminho determinístico de fallback.
 */
export async function gerarJSON<T = any>(
  prompt: string,
  systemInstruction: string,
  timeoutMs = 15000,
  jsonSchema?: JsonSchema,
): Promise<RespostaJSON<T> | null> {
  const groq = getGroq();
  if (!groq) {
    console.warn('⚠️ [IA] GROQ_API_KEY ausente. Seguindo sem LLM.');
    return null;
  }

  const mensagens = [
    { role: 'system' as const, content: systemInstruction },
    { role: 'user' as const, content: prompt },
  ];

  if (jsonSchema && jsonSchemaSuportado) {
    try {
      const resp: any = await comTimeout(
        groq.chat.completions.create({
          model: GROQ_MODEL,
          messages: mensagens,
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: jsonSchema.name,
              schema: jsonSchema.schema,
              strict: jsonSchema.strict ?? true,
            },
          },
        } as any),
        timeoutMs,
        'groq',
      );
      const texto = resp.choices[0]?.message?.content?.trim() ?? '';
      if (!texto) return null;
      return { dados: JSON.parse(texto) as T, uso: lerUso(resp) };
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/json_schema|response_format|structured|unsupported|invalid.*format/i.test(msg)) {
        console.warn('⚠️ [IA] json_schema não suportado por este modelo; usando json_object daqui pra frente.');
        jsonSchemaSuportado = false;
      } else {
        console.error('❌ [IA] json_schema falhou:', msg);
        return null;
      }
    }
  }

  try {
    const resp: any = await comTimeout(
      groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: mensagens,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      timeoutMs,
      'groq',
    );
    const texto = resp.choices[0]?.message?.content?.trim() ?? '';
    if (!texto) return null;
    return { dados: JSON.parse(texto) as T, uso: lerUso(resp) };
  } catch (err: any) {
    console.error('❌ [IA] Groq (JSON) falhou:', err?.message || err);
    return null;
  }
}
