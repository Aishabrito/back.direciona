// src/ia/reformulador_pergunta.ts
// Reformula perguntas de triagem em tom natural pro WhatsApp.
// NUNCA introduz nome de doença, remédio ou dose.

import { gerarTexto } from '../servicos/ia.js';
import { normalizarTexto } from './normalizar.js';
import { sanitizarTextoGerado } from './mensagens.js';

// [CAMADA EXTRA] Bloqueios do reformulador.
// Se qualquer termo abaixo aparecer na resposta gerada, descarta e usa a pergunta fixa.
const TERMOS_PROIBIDOS_REFORM =
  /\b(rem[eé]dio|medicamento|comprimido|antib[ió]tico|diagn[oó]stico|infarto|avc|derrame|doen[cç]a|dose|mg|ml|voc[eê] (pode|deve) ter|parece ser|compat[íi]vel com|quadro de|provavelmente|possivelmente|suspeita de|indica|sugere)\b/i;

// [CAMADA EXTRA] Doenças — nunca devem aparecer numa pergunta de triagem.
const DOENCAS_REFORM =
  /\b(gripe|influenza|dengue|zika|chikungunya|covid|coronavirus|pneumonia|meningite|apendicite|cancer|asma|bronquite|hepatite|tuberculose|hanseniase|sinusite|amigdalite|rinite|otite|conjuntivite|anemia|diabetes|hipertens[aã]o|trombose|arritmia)\b/i;

export async function reformularPergunta(
  perguntaFixa: string,
  contexto: string,
): Promise<string> {
  const prompt = `CONTEXTO DO PACIENTE: ${contexto}
PERGUNTA ORIGINAL: ${perguntaFixa}`;

  const systemInstruction = `Reformule a pergunta abaixo em UMA frase curta, acolhedora e natural, para WhatsApp.

REGRAS ABSOLUTAS:
- Não dê diagnóstico.
- Não sugira doença específica.
- Não mencione remédio, dose ou medicamento.
- Não invente informação clínica.
- Mantenha o mesmo sentido da pergunta original.
- Devolva apenas a frase reformulada, terminando com UM único "?".

Se não conseguir reformular com segurança, devolva EXATAMENTE a pergunta original, sem alteração.`;

  const texto = await gerarTexto(prompt, systemInstruction, 10000);

  // ── Validações de segurança ──
  if (!texto) return perguntaFixa;
  if (texto.length > 300) return perguntaFixa;

  const textoNorm = normalizarTexto(texto);

  // Bloqueia termos proibidos (remédio, diagnóstico, etc)
  if (TERMOS_PROIBIDOS_REFORM.test(textoNorm)) {
    console.warn(`⚠️ [reform] termo proibido — mantendo pergunta original`);
    return perguntaFixa;
  }

  // Bloqueia nome de doença (gripe, dengue, covid...)
  if (DOENCAS_REFORM.test(textoNorm)) {
    console.warn(`⚠️ [reform] doença mencionada — mantendo pergunta original`);
    return perguntaFixa;
  }

  // Exige exatamente 1 "?" (evita duas perguntas coladas)
  const numInterrogacoes = (texto.match(/\?/g) || []).length;
  if (numInterrogacoes !== 1) {
    console.warn(`⚠️ [reform] ${numInterrogacoes} interrogações — mantendo original`);
    return perguntaFixa;
  }

  // Exige terminar com "?"
  if (!texto.trim().endsWith('?')) return perguntaFixa;

  // Sanitização final (mesma usada no resto do bot)
  const sanitizado = sanitizarTextoGerado(texto);
  if (sanitizado !== texto) {
    console.warn(`⚠️ [reform] sanitização alterou — mantendo original`);
    return perguntaFixa;
  }

  return texto;
}