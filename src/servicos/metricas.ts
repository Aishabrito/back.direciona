
export const metricas = {
  total_mensagens: 0,
  total_audios: 0,
  total_fotos_sem_legenda: 0,

  decisor_llm: 0,         // turnos decididos pelo LLM
  decisor_fallback: 0,    // LLM falhou → caminho determinístico
  guarda_regex: 0,        // guarda crítica escalou antes do LLM
  validacao_alterou: 0,   // validação final mexeu na decisão
  reformulacoes: 0,       // usuário repetiu/reformulou (resposta anterior falhou)
  escalonamentos: 0,      // 3ª reformulação → encaminhado a canal humano
  llm_tokens_in: 0,
  llm_tokens_out: 0,

  gemini_tts_ok: 0,
  gemini_tts_erro: 0,

  overpass_falha: 0,
  google_places_falha: 0,
  nominatim_falha: 0,

  // Distribuição por ação do decisor
  decisoes: {} as Record<string, number>,

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