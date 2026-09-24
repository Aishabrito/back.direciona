export const VERSAO_REGRAS = '1.0.0';

export const IDADE_GRUPOS = [
  'bebe', 'crianca', 'adolescente', 'adulto', 'idoso', 'nao_informado',
] as const;

export const VALORES_SIM_NAO = ['sim', 'nao', 'nao_informado'] as const;

export const RISCOS_MENTAIS = [
  'iminente', 'sem_risco_imediato', 'nao_mencionado',
] as const;

export const CATEGORIAS_INTERNAS = [
  'emergencia', 'urgencia', 'baixa_gravidade',
  'saude_mental_sem_risco_imediato', 'situacao_obstetrica',
  'informacao_insuficiente', 'fora_do_escopo',
] as const;

export const DESTINOS = [
  'SAMU_192', 'PRONTO_SOCORRO', 'SAMU_192_PRONTO_SOCORRO',
  'UPA_24H', 'UBS_CLINICA_DA_FAMILIA',
  'MATERNIDADE_PRONTO_SOCORRO_OBSTETRICO',
  'CAPS_OU_SERVICO_DE_SAUDE_MENTAL',
  'FALLBACK',
] as const;

export const NIVEIS = ['SAMU_AGORA', 'UPA_AGORA', 'HOJE', 'AGENDAR'] as const;

export type IdadeGrupo = (typeof IDADE_GRUPOS)[number];
export type SimNao = (typeof VALORES_SIM_NAO)[number];
export type RiscoMental = (typeof RISCOS_MENTAIS)[number];
export type CategoriaInterna = (typeof CATEGORIAS_INTERNAS)[number];
export type Destino = (typeof DESTINOS)[number];
export type FlagTriState = boolean | 'nao_informado';
export type Nivel = (typeof NIVEIS)[number];

export type MensagemHistorico = {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
};

export type RelatoEstruturado = {
  relato_sobre_terceiro: boolean;
  pessoa: string;
  idade_grupo: IdadeGrupo;
  idade_numerica: number | null;
  sintomas: string[];
  sinais_alerta: string[];
  inicio: string;
  duracao: string;
  piora: SimNao;
  intensidade: string;
  falta_de_ar: FlagTriState;
  dor_no_peito: FlagTriState;
  desmaio: FlagTriState;
  confusao: FlagTriState;
  sangramento: FlagTriState;
  febre: FlagTriState;
  vomitos: FlagTriState;
  trauma: FlagTriState;
  exposicao_intoxicacao: FlagTriState;
  gestante: SimNao;
  pos_parto: SimNao;
  risco_mental: RiscoMental;
  informacao_insuficiente: boolean;
  informacoes_contraditorias: string[];
  sinais_obstetricos: string[];
  sinais_trauma: string[];
  sinais_neurologicos: string[];
  fala_frases: FlagTriState;
  labios_roxos: FlagTriState;
  consegue_beber: FlagTriState;
  alergia_grave: FlagTriState;
  autodiagnostico_grave: string | null;
  texto_original_acumulado: string;

  // [Task 1] Intenção detectada pelo extrator (structured output).
  // Ainda não usada no roteamento — Task 2 vai consumir.
  intencao?: string;
};

export type DecisaoRegras = {
  categoria_interna: CategoriaInterna;
  destino: Destino;
  resposta_id: string;
  regra_acionada: string;
  versao_regras: string;
  nivel: Nivel;
  motivos: string[];
};

export type MensagemAprovada = {
  id: string;
  destino: string[];
  texto: string;
};

export type TurnoResultado =
  | { tipo: 'orientacao'; texto: string; decisao: DecisaoRegras }
  | { tipo: 'perguntas'; texto: string; perguntas: string[]; tema: string };

export type UltimaPergunta = {
  id: string;
  campoAlvo?: keyof RelatoEstruturado;
  texto: string;
};

export type FaseConversa = 'inicio' | 'coletando' | 'orientado' | 'encerrado';

export type EstadoConversa = {
  relatos: RelatoEstruturado[];
  rodadasPerguntas: number;
  temaPergunta?: string;
  texto_original_acumulado: string;
  fase: FaseConversa;
  perguntasJaFeitas: string[];
  historico?: MensagemHistorico[];
  ultimaPergunta?: UltimaPergunta;
  aguardandoLocalizacao?: {
    ativo: boolean;
    tipo: 'UPA' | 'HOSPITAL' | 'UBS';
    mensagemOriginal: string;
    aguardandoTexto?: boolean;
  };
  ultimaLocalizacao?: { lat: number; lng: number; em: number };
};

export const ESTADO_INICIAL: EstadoConversa = {
  relatos: [],
  rodadasPerguntas: 0,
  texto_original_acumulado: '',
  fase: 'inicio',
  perguntasJaFeitas: [],
  historico: [],
};

export const RELATO_VAZIO: RelatoEstruturado = {
  relato_sobre_terceiro: false,
  pessoa: 'nao_informado',
  idade_grupo: 'nao_informado',
  idade_numerica: null,
  sintomas: [],
  sinais_alerta: [],
  inicio: 'nao_informado',
  duracao: 'nao_informado',
  piora: 'nao_informado',
  intensidade: 'nao_informado',
  falta_de_ar: 'nao_informado',
  dor_no_peito: 'nao_informado',
  desmaio: 'nao_informado',
  confusao: 'nao_informado',
  sangramento: 'nao_informado',
  febre: 'nao_informado',
  vomitos: 'nao_informado',
  trauma: 'nao_informado',
  exposicao_intoxicacao: 'nao_informado',
  gestante: 'nao_informado',
  pos_parto: 'nao_informado',
  risco_mental: 'nao_mencionado',
  informacao_insuficiente: true,
  informacoes_contraditorias: [],
  sinais_obstetricos: [],
  sinais_trauma: [],
  sinais_neurologicos: [],
  fala_frases: 'nao_informado',
  labios_roxos: 'nao_informado',
  consegue_beber: 'nao_informado',
  alergia_grave: 'nao_informado',
  autodiagnostico_grave: null,
  texto_original_acumulado: '',
};