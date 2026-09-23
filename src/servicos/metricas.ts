
export const metricas = {
  total_mensagens: 0,
  total_audios: 0,
  total_fotos_sem_legenda: 0,

  gemini_texto_ok: 0,
  gemini_texto_timeout: 0,
  gemini_texto_erro: 0,
  local_only: 0, // quando o extrator local já resolveu, sem chamar Gemini

  gemini_audio_ok: 0,
  gemini_audio_timeout: 0,
  gemini_audio_erro: 0,
  gemini_tts_ok: 0,
  gemini_tts_erro: 0,

  overpass_falha: 0,
  google_places_falha: 0,
  nominatim_falha: 0,

  // Distribuição de decisões por nível
  decisoes: {
    SAMU_AGORA: 0,
    UPA_AGORA: 0,
    HOJE: 0,
    AGENDAR: 0,
    FALLBACK: 0,
  } as Record<string, number>,

  // Por destino
  destinos: {} as Record<string, number>,

  iniciado_em: new Date().toISOString(),
};

export function inc(chave: keyof typeof metricas, delta = 1): void {
  const atual = metricas[chave];
  if (typeof atual === 'number') {
    (metricas[chave] as number) = atual + delta;
  }
}

export function incDecisao(nivel: string): void {
  metricas.decisoes[nivel] = (metricas.decisoes[nivel] ?? 0) + 1;
}

export function incDestino(destino: string): void {
  metricas.destinos[destino] = (metricas.destinos[destino] ?? 0) + 1;
}