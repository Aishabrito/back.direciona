// src/ia/reformulador_pergunta.ts
import { gerarTexto } from '../servicos/ia.js';
import { normalizarTexto } from './normalizar.js';
import { sanitizarTextoGerado } from './mensagens.js';

const TERMOS_PROIBIDOS_REFORM =
  /\b(remedio|medicamento|comprimido|antibiotico|diagnostico|infarto|avc|doenca|dose|mg|ml)\b/i;

export async function reformularPergunta(
  perguntaFixa: string,
  contexto: string,
): Promise<string> {
  const prompt = `CONTEXTO DO PACIENTE: ${contexto}
PERGUNTA ORIGINAL: ${perguntaFixa}`;

  const systemInstruction = `Reformule a pergunta abaixo em UMA frase curta, acolhedora e natural, para WhatsApp.
REGRAS:
- Não dê diagnóstico, não sugira remédio, não prescreva.
- Não invente informação clínica.
- Mantenha o mesmo sentido da pergunta.
- Devolva apenas a frase reformulada (terminando com "?").`;

  const texto = await gerarTexto(prompt, systemInstruction, 10000);

  if (!texto) return perguntaFixa;
  if (texto.length > 300) return perguntaFixa;
  if (TERMOS_PROIBIDOS_REFORM.test(normalizarTexto(texto))) return perguntaFixa;
  if (!texto.endsWith('?')) return perguntaFixa;

  const sanitizado = sanitizarTextoGerado(texto);
  if (sanitizado !== texto) return perguntaFixa;

  return texto;
}