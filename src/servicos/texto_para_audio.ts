
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { Readable, PassThrough } from 'stream';
import { GoogleGenAI } from '@google/genai';

// Aponta o fluent-ffmpeg pro binário baixado pelo @ffmpeg-installer.
// Se você instalar o ffmpeg via apt (opção B do README), remova estas 2 linhas.
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export type VozTts = 'feminina' | 'masculina';

// Vozes do Gemini 2.5 Flash TTS. Aoede = feminina natural, Charon = masculina.
const VOZES: Record<VozTts, string> = {
  feminina: 'Aoede',
  masculina: 'Charon',
};

/**
 * Converte texto em OGG/Opus pronto para o WhatsApp.
 * Devolve null se a API falhar ou não estiver configurada.
 */
export async function textoParaAudio(
  texto: string,
  voz: VozTts = 'feminina',
): Promise<Buffer | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ GEMINI_API_KEY não definida. Resposta será em texto.');
    return null;
  }

  // Limpa markdown que ficaria estranho na fala
  const limpo = texto
    .replace(/\*([^*]+)\*/g, '$1')       // *negrito*
    .replace(/_([^_]+)_/g, '$1')          // _itálico_
    .replace(/\n{2,}/g, '. ')             // parágrafos viram pausa
    .replace(/\n/g, ' ')
    .replace(/https?:\/\/\S+/g, '')       // remove URLs
    .replace(/\s+/g, ' ')
    .trim();

  if (limpo.length === 0) return null;

  // Gemini TTS tem limite de tokens de saída. Corta com folga em 2000 chars.
  const textoCortado = limpo.length > 2000 ? limpo.slice(0, 2000) + '...' : limpo;

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text: textoCortado }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: VOZES[voz] },
          },
        },
      },
    });

    // A resposta traz base64 de PCM cru. O MIME vem no inlineData.
    const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      console.error('❌ Gemini TTS respondeu sem áudio');
      return null;
    }

    const mime = inlineData.mimeType ?? '';
    // Ex.: "audio/L16;codec=pcm;rate=24000" (s16le) ou "audio/pcm;rate=24000"
    const rateMatch = mime.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

    const pcm = Buffer.from(inlineData.data, 'base64');
    const wav = pcmParaWav(pcm, sampleRate, 1, 16);
    const ogg = await wavParaOggOpus(wav);
    return ogg;
  } catch (err) {
    console.error('❌ Gemini TTS falhou:', err);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Envolve PCM s16le em container WAV (ffmpeg lê WAV, não PCM cru)
// ────────────────────────────────────────────────────────────
function pcmParaWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // subchunk1Size
  header.writeUInt16LE(1, 20);           // audioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ────────────────────────────────────────────────────────────
// Converte WAV → OGG/Opus via ffmpeg (streaming, sem arquivos temporários)
// ────────────────────────────────────────────────────────────
function wavParaOggOpus(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const entrada = Readable.from(wav);
    const saida = new PassThrough();
    const chunks: Buffer[] = [];
    saida.on('data', (c) => chunks.push(c));
    saida.on('end', () => resolve(Buffer.concat(chunks)));
    saida.on('error', reject);

    ffmpeg(entrada)
      .inputFormat('wav')
      .audioCodec('libopus')
      .audioBitrate('32k')               // bitrate típico de voice note
      .audioChannels(1)
      .audioFrequency(48000)             // Opus trabalha em 48kHz
      .format('ogg')
      .outputOptions([
        '-application', 'voip',          // otimizado pra voz
        '-frame_duration', '60',         // frames de 60ms (padrão do WhatsApp)
        '-vbr', 'on',
      ])
      .on('error', (err) => {
        console.error('❌ ffmpeg falhou:', err.message);
        reject(err);
      })
      .pipe(saida, { end: true });
  });
}