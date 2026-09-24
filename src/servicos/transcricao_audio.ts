

import OpenAI, { toFile } from 'openai';

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const WHISPER_MODEL =
  process.env.GROQ_WHISPER_MODEL ?? 'whisper-large-v3-turbo';

/**
 * Transcreve um áudio (buffer OGG/Opus do WhatsApp) usando Groq Whisper.
 * Devolve string vazia se não conseguir transcrever.
 */
export async function transcreverAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg; codecs=opus',
): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️ [Whisper] GROQ_API_KEY ausente.');
    return '';
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn('⚠️ [Whisper] buffer vazio');
    return '';
  }

  // Detecta extensão pelo MIME pra o Whisper aceitar sem reclamar
  const ext = mimeType.includes('mp4')
    ? 'mp4'
    : mimeType.includes('mpeg')
    ? 'mp3'
    : mimeType.includes('wav')
    ? 'wav'
    : 'ogg';

  const mimeLimpo = mimeType.split(';')[0].trim();

  try {
    const arquivo = await toFile(audioBuffer, `audio.${ext}`, {
      type: mimeLimpo,
    });

    console.log(`🎧 [Whisper] enviando ${(audioBuffer.length / 1024).toFixed(1)} KB...`);

    const promessa = groq.audio.transcriptions.create({
      file: arquivo,
      model: WHISPER_MODEL,
      language: 'pt',           // força pt-BR (melhora precisão)
      response_format: 'text',  // devolve string pura
      temperature: 0,
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout whisper')), 30000),
    );

    const resp = (await Promise.race([promessa, timeout])) as any;
    const texto = (typeof resp === 'string' ? resp : resp?.text ?? '').trim();

    if (!texto) {
      console.log('⚠️ [Whisper] transcrição vazia');
      return '';
    }

    // Remove aspas/backticks que às vezes vêm
    return texto.replace(/^["'`]+|["'`]+$/g, '').trim();
  } catch (err: any) {
    console.error('❌ [Whisper] falhou:', err?.message || err);
    return '';
  }
}