

import { GoogleGenAI } from '@google/genai';

const PROMPT_TRANSCRICAO = `Transcreva literalmente este áudio em português brasileiro.

REGRAS:
- Devolva APENAS o texto falado, sem comentários, sem aspas, sem introdução.
- NÃO corrija gramática. NÃO reformule. NÃO traduza.
- Mantenha gírias, erros e repetições como foram falados ("cê", "tá", "tô", "né").
- Se houver várias falas, separe por espaço em uma única linha.
- Se estiver inaudível, só com ruído, ou sem fala inteligível, devolva string vazia.
- Pode ser fala com sotaque, com pressa, com choro, com barulho de fundo.
  Faça o melhor esforço para entender o conteúdo clínico.
- Não adicione pontuação que não foi falada.`;

export async function transcreverAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg; codecs=opus',
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GEMINI_API_KEY ausente. Transcrição indisponível.');
    return '';
  }

  const mimeLimpo = mimeType.split(';')[0].trim();
  const base64Audio = audioBuffer.toString('base64');

  try {
    const ai = new GoogleGenAI({ apiKey });

    // gemini-2.5-pro é mais preciso que flash para transcrição com ruído
    const promessa = ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [
        { inlineData: { mimeType: mimeLimpo, data: base64Audio } },
        { text: PROMPT_TRANSCRICAO },
      ],
      config: {
        temperature: 0,
      },
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout transcrição')), 20000),
    );
    const response = (await Promise.race([promessa, timeout])) as any;
    const texto = (response.text || '').trim();

    if (texto.length < 2) return '';
    return texto.replace(/^["'`]+|["'`]+$/g, '').trim();
  } catch (err) {
    console.error('❌ Transcrição falhou:', err);
    return '';
  }
}