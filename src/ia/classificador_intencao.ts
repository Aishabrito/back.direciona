

import { gerarTexto } from '../servicos/ia.js';
import { normalizarTexto } from './normalizar.js';

export type Intencao =
  | 'conhecimento'
  | 'navegacao'
  | 'relato'
  | 'saudacao'
  | 'agradecimento'
  | 'outro';

const SISTEMA = `Você classifica a INTENÇÃO de mensagens enviadas a um assistente do SUS.

Responda SEMPRE com UMA única palavra, exatamente uma das opções abaixo:

CONHECIMENTO — pergunta genérica sobre saúde ou sobre o SUS, sem pedir encaminhamento.
  Ex: "o que é dengue", "qual a temperatura de febre", "quantos graus é febre",
      "diferença entre UBS e UPA", "como funciona o CAPS", "quando devo me preocupar com febre"

NAVEGACAO — pede indicação de ONDE ir / qual serviço procurar, citando ou não sintoma.
  Ex: "para onde vou com dor de cabeça", "onde devo ir", "o que faço",
      "me indica um posto", "aonde levo meu filho com febre", "para onde vou com febre"

RELATO — descreve sintoma próprio em 1ª pessoa, sem pedir encaminhamento nem explicação.
  Ex: "estou com dor de cabeça", "sinto febre há 2 dias", "to com falta de ar"

SAUDACAO — cumprimento isolado. Ex: "oi", "bom dia", "tudo bem?"

AGRADECIMENTO — agradece/encerra. Ex: "obrigado", "valeu", "ok, entendi"

OUTRO — nada das categorias acima.

REGRA DE DESEMPATE (MUITO IMPORTANTE):
- Se a mensagem tem QUALQUER forma de "onde ir", "para onde vou", "onde procuro",
  "aonde levo" → é NAVEGACAO, mesmo com sintoma mencionado.
  Ex: "para onde vou com febre" → NAVEGACAO (não RELATO).
- Se tem pergunta genérica E sintoma próprio → CONHECIMENTO (a pergunta é o que importa).
- Se só relata sintoma, sem pergunta e sem pedir onde ir → RELATO.

Use o HISTÓRICO abaixo para desambiguar mensagens curtas:
- "e se for 40 graus?" precedido de "estou com febre" → CONHECIMENTO
- "e agora?" precedido de "meu filho está com febre" → RELATO
- Sem histórico, trate a mensagem isolada.

Responda SÓ a palavra, nada mais.`;

export async function classificarIntencao(
  texto: string,
  historicoFormatado?: string,
): Promise<Intencao> {
  const limpo = texto.trim();
  if (!limpo) return 'outro';

  // Fast-path: saudações e agradecimentos curtos — evita gastar LLM em "oi".
  const n = normalizarTexto(limpo);
  const palavras = n.split(/\s+/).filter(Boolean);

  if (
    palavras.length <= 3 &&
    /^(oi|ola|bom dia|boa tarde|boa noite|e ai|opa|tudo bem|eae)\b/.test(n)
  ) {
    return 'saudacao';
  }
  if (
    palavras.length <= 3 &&
    /^(obrigad|valeu|brigad|vlw|ok|blz|beleza)\b/.test(n)
  ) {
    return 'agradecimento';
  }

  const prompt = `${
    historicoFormatado && historicoFormatado !== '(sem histórico)'
      ? `HISTÓRICO RECENTE:\n${historicoFormatado}\n\n---\n\n`
      : ''
  }MENSAGEM ATUAL:
"${limpo}"`;

  try {
   const resposta = await gerarTexto(prompt, SISTEMA);
    const palavra = (resposta ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');

    const mapa: Record<string, Intencao> = {
      CONHECIMENTO: 'conhecimento',
      NAVEGACAO: 'navegacao',
      RELATO: 'relato',
      SAUDACAO: 'saudacao',
      AGRADECIMENTO: 'agradecimento',
      OUTRO: 'outro',
    };

    for (const chave of [
      'CONHECIMENTO',
      'NAVEGACAO',
      'RELATO',
      'SAUDACAO',
      'AGRADECIMENTO',
      'OUTRO',
    ]) {
      if (palavra.includes(chave)) return mapa[chave];
    }

    console.warn(`⚠️ [INTENT] resposta inesperada: "${resposta}" → assumindo 'outro'`);
    return 'outro';
  } catch (err: any) {
    console.error(`❌ [INTENT] falha ao classificar:`, err?.message || err);
    return 'relato';
  }
}