// src/servicos/geolocalizacao.ts

export type CategoriaUnidade = 'UPA' | 'EMERGENCIA' | 'UBS';
export type TipoBusca = 'UPA' | 'EMERGENCIA' | 'HOSPITAL' | 'UBS' | 'TODOS';

export type UnidadeSaude = {
  nome: string;
  categoria: CategoriaUnidade;
  endereco: string;
  telefone: string | null;
  distancia: number;
  lat: number;
  lng: number;
  publica: boolean | null;
  especializada: boolean;
  semNome: boolean;
  linkGoogleMaps: string;
};

type Tags = Record<string, string | undefined>;
type ElementoOsm = {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
};

const RAIOS_M = [10_000, 30_000, 60_000];
const TIMEOUT_MS = 14_000;
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const USER_AGENT = 'DirecionaSUSBot/1.0 (contato: aisha.paola14@gmail.com)';

const PENALIDADE_ESPECIALIZADA_M = 10_000;
const PENALIDADE_SEM_NOME_M = 3_000;
const BONUS_PUBLICA_M = 1_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const norm = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '').toLowerCase().trim();

const UPA_FORTE_RE =
  /\bupa\b|\bupa ?24|\bupae\b|unidade de pronto ?atendimento|unidade de pronto ?socorro|coordenacao de emergencia regional/;
const CER_RE = /\bcer\b/;
const UPA_FRACA_RE = /pronto ?atendimento|servico de pronto|\bpa\b/;
const HOSPITAL_RE = /\bhosp(ital)?\b|santa casa|\bhps\b/;
const PRONTO_SOCORRO_RE = /pronto ?socorro|\bps\b|\bpsm\b|emergencia|urgencia/;
const UBS_RE =
  /\bubs\b|\bubsf\b|\busf\b|unidade basica|unidade de saude|clinica da familia|saude da familia|posto de saude|centro municipal de saude|centro de saude|\bcms\b|modulo do medico de familia|\bpsf\b|policlinica|atencao primaria/;
const EXCLUIR_RE =
  /odonto|dentist|estetic|veterinar|\bvet\b|laborator|fisioterap|psicolog|nutric|otica|fonoaudi|cosmet|\bpet\b|reabilit|centro especializado|\bcaps\b|hemodialise|dialise|radiolog|diagnostic|imagem|vacina|farmacia|drogaria|hemocentro|banco de sangue|acupuntura|pilates|academia|estacionamento|funeraria|cemiterio|\bspa\b/;
const ESPECIALIZADA_RE =
  /oftalm|olhos|psiquiatr|saude mental|oncolog|cancer|\binca\b|ortoped|traumato|maternidade|materno|infantil|pediatri|crianc|cardiol|geriatr|idosos|hospital dia|queimad|otorrino/;
const PUBLICA_RE =
  /municipal|estadual|federal|\bsus\b|prefeitura|secretaria|\bupa\b|\bcer\b|\bubs\b|clinica da familia|\bcms\b|universitario/;

function classificar(tags: Tags, nomeNorm: string): CategoriaUnidade | null {
  const amenity = tags.amenity ?? '';
  const healthcare = tags.healthcare ?? '';

  if (['dentist', 'veterinary', 'pharmacy'].includes(amenity)) return null;
  if (['dentist', 'veterinary', 'pharmacy', 'laboratory', 'alternative', 'rehabilitation'].includes(healthcare))
    return null;
  if (nomeNorm && EXCLUIR_RE.test(nomeNorm)) return null;

  const temTagSaude = ['hospital', 'clinic', 'doctors'].includes(amenity) || healthcare !== '';
  const ehHospitalTag = amenity === 'hospital' || healthcare === 'hospital' || tags.building === 'hospital';
  const urgencia24h =
    tags.emergency === 'yes' || tags.opening_hours === '24/7' || tags['healthcare:speciality'] === 'emergency';

  const cerEhUpa = CER_RE.test(nomeNorm);
  const upaForte = UPA_FORTE_RE.test(nomeNorm) || cerEhUpa;

  if (!temTagSaude && !ehHospitalTag && !upaForte) return null;

  if (nomeNorm) {
    if (upaForte) return 'UPA';
    if (HOSPITAL_RE.test(nomeNorm)) return 'EMERGENCIA';
    if (UPA_FRACA_RE.test(nomeNorm)) return 'UPA';
    if (PRONTO_SOCORRO_RE.test(nomeNorm)) return 'EMERGENCIA';
    if (UBS_RE.test(nomeNorm)) return 'UBS';
  }

  if (ehHospitalTag) return 'EMERGENCIA';
  if (amenity === 'clinic' && urgencia24h) return 'UPA';
  return null;
}

export function classificarPorNome(nome: string, tags: Tags = { amenity: 'clinic' }): CategoriaUnidade | null {
  return classificar(tags, norm(nome));
}

function montarQuery(lat: number, lng: number, raio: number): string {
  const a = `(around:${raio},${lat},${lng})`;
  const nomes = [
    '(^|[ -])UPA([ -]|$)',
    '(^|[ -])CER([ -]|$)',
    '(^|[ -])UBS([ -]|$)',
    'Pronto[ -]?Atendimento',
    'Pronto[ -]?Socorro',
    'Emerg.ncia',
    'Urg.ncia',
    'Hospital',
    'Santa Casa',
    'Cl.nica da Fam.lia',
    'Posto de Sa.de',
    'Centro (Municipal )?de Sa.de',
    'Unidade (B.sica|de Sa.de)',
    'Policl.nica',
  ].join('|');
  const semRuido = '[!"highway"][!"railway"][!"public_transport"][!"shop"][!"leisure"][!"tourism"][!"landuse"][!"barrier"]';

  return `[out:json][timeout:12];
(
  nwr["amenity"="hospital"]${a};
  nwr["healthcare"="hospital"]${a};
  nwr["emergency"="yes"]["amenity"~"^(clinic|hospital|doctors)$"]${a};
  nwr["name"~"${nomes}",i]${semRuido}${a};
);
out center tags;`;
}

async function consultarMirror(url: string, query: string, sinal: AbortSignal): Promise<ElementoOsm[]> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: `data=${encodeURIComponent(query)}`,
    signal: sinal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`);
  const data = (await resp.json()) as { elements?: ElementoOsm[]; remark?: string };
  if (data.remark && /timed out|out of memory|runtime error/i.test(data.remark)) {
    throw new Error(`Overpass remark: ${data.remark}`);
  }
  if (!Array.isArray(data.elements)) throw new Error('Resposta sem "elements"');
  return data.elements;
}

function primeiroSucesso<T>(promessas: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let falhas = 0;
    promessas.forEach((p) =>
      p.then(resolve).catch(() => {
        falhas += 1;
        if (falhas === promessas.length) reject(new Error('Todos os espelhos do Overpass falharam'));
      }),
    );
  });
}

async function consultarOverpass(lat: number, lng: number, raio: number): Promise<ElementoOsm[]> {
  const query = montarQuery(lat, lng, raio);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await primeiroSucesso(MIRRORS.map((u) => consultarMirror(u, query, controller.signal)));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const cache = new Map<string, { em: number; elementos: ElementoOsm[] }>();

async function obterElementos(lat: number, lng: number, raio: number): Promise<ElementoOsm[] | null> {
  const chave = `${lat.toFixed(2)}|${lng.toFixed(2)}|${raio}`;
  const hit = cache.get(chave);
  if (hit && Date.now() - hit.em < CACHE_TTL_MS) return hit.elementos;

  try {
    const elementos = await consultarOverpass(lat, lng, raio);
    cache.set(chave, { em: Date.now(), elementos });
    if (cache.size > 100) {
      const maisAntiga = cache.keys().next().value;
      if (maisAntiga !== undefined) cache.delete(maisAntiga);
    }
    return elementos;
  } catch (err) {
    console.error(`❌ Overpass falhou (raio ${raio / 1000} km):`, err);
    return null;
  }
}

function calcularDistancia(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const NOME_GENERICO: Record<CategoriaUnidade, string> = {
  UPA: 'UPA / Pronto Atendimento (sem nome cadastrado)',
  EMERGENCIA: 'Hospital / Pronto-Socorro (sem nome cadastrado)',
  UBS: 'Unidade Básica de Saúde (sem nome cadastrado)',
};

function distanciaEfetiva(u: UnidadeSaude): number {
  let d = u.distancia;
  if (u.especializada) d += PENALIDADE_ESPECIALIZADA_M;
  if (u.semNome) d += PENALIDADE_SEM_NOME_M;
  if (u.publica === true) d -= BONUS_PUBLICA_M;
  return Math.max(0, d);
}

export function processarElementos(elementos: ElementoOsm[], lat: number, lng: number): UnidadeSaude[] {
  const unidades: UnidadeSaude[] = [];

  for (const el of elementos) {
    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;
    if (elLat == null || elLng == null) continue;

    const tags = el.tags ?? {};
    const nomeOriginal = tags.name ?? tags['name:pt'] ?? tags.official_name ?? tags.alt_name ?? null;
    const nomeNorm = nomeOriginal ? norm(nomeOriginal) : '';

    const categoria = classificar(tags, nomeNorm);
    if (!categoria) continue;

    const urgencia24h = tags.emergency === 'yes' || tags['healthcare:speciality'] === 'emergency';
    const especializada =
      categoria === 'EMERGENCIA' &&
      ESPECIALIZADA_RE.test(nomeNorm) &&
      !urgencia24h &&
      !PRONTO_SOCORRO_RE.test(nomeNorm);

    const operadorNorm = norm(`${tags.operator ?? ''}`);
    const tipoOperador = tags['operator:type'];
    let publica: boolean | null = null;
    if (tipoOperador === 'public' || tipoOperador === 'government') publica = true;
    else if (tipoOperador === 'private') publica = false;
    else if (PUBLICA_RE.test(`${nomeNorm} ${operadorNorm}`)) publica = true;

    const endereco =
      [
        [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(', '),
        tags['addr:suburb'] ?? tags['addr:neighbourhood'],
        tags['addr:city'],
      ]
        .filter(Boolean)
        .join(' - ') ||
      tags['addr:full'] ||
      'Endereço não informado';

    unidades.push({
      nome: nomeOriginal ?? NOME_GENERICO[categoria],
      categoria,
      endereco,
      telefone: tags.phone ?? tags['contact:phone'] ?? null,
      distancia: calcularDistancia(lat, lng, elLat, elLng),
      lat: elLat,
      lng: elLng,
      publica,
      especializada,
      semNome: nomeOriginal == null,
      linkGoogleMaps: `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${elLat},${elLng}`,
    });
  }

  unidades.sort((a, b) => distanciaEfetiva(a) - distanciaEfetiva(b));

  const unicas: UnidadeSaude[] = [];
  for (const u of unidades) {
    const repetida = unicas.some(
      (o) =>
        o.categoria === u.categoria &&
        norm(o.nome) === norm(u.nome) &&
        calcularDistancia(o.lat, o.lng, u.lat, u.lng) < 200,
    );
    if (!repetida) unicas.push(u);
  }
  return unicas;
}

async function buscarPorCategorias(lat: number, lng: number, desejadas: CategoriaUnidade[]): Promise<UnidadeSaude[]> {
  let ultimas: UnidadeSaude[] = [];
  for (const raio of RAIOS_M) {
    console.log(`🔍 Buscando ${desejadas.join('/')} em ${raio / 1000} km...`);
    const elementos = await obterElementos(lat, lng, raio);
    if (elementos === null) continue;
    ultimas = processarElementos(elementos, lat, lng);
    if (ultimas.some((u) => desejadas.includes(u.categoria))) break;
  }
  return ultimas;
}

export async function buscarUnidadesProximas(
  lat: number,
  lng: number,
  tipo: TipoBusca = 'TODOS',
  _raioIgnorado?: number,
): Promise<UnidadeSaude[]> {
  const cat: CategoriaUnidade | 'TODOS' = tipo === 'HOSPITAL' ? 'EMERGENCIA' : tipo;

  if (cat === 'UBS') {
    const todas = await buscarPorCategorias(lat, lng, ['UBS']);
    return todas.filter((u) => u.categoria === 'UBS').slice(0, 5);
  }

  const todas = await buscarPorCategorias(lat, lng, ['UPA', 'EMERGENCIA']);
  const urgencia = todas.filter((u) => u.categoria !== 'UBS');

  if (cat === 'UPA' || cat === 'EMERGENCIA') {
    const principais = urgencia.filter((u) => u.categoria === cat);
    return (principais.length > 0 ? principais : urgencia).slice(0, 5);
  }
  return urgencia.slice(0, 5);
}

export async function buscarUpaEEmergencia(
  lat: number,
  lng: number,
): Promise<{ upas: UnidadeSaude[]; emergencias: UnidadeSaude[] }> {
  const todas = await buscarPorCategorias(lat, lng, ['UPA', 'EMERGENCIA']);
  return {
    upas: todas.filter((u) => u.categoria === 'UPA').slice(0, 2),
    emergencias: todas.filter((u) => u.categoria === 'EMERGENCIA').slice(0, 2),
  };
}

function formatarDistancia(metros: number): string {
  if (metros < 1000) return `${Math.max(10, Math.round(metros / 10) * 10)} m`;
  return `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
}

const TITULO: Record<CategoriaUnidade, string> = {
  UPA: '🚑 *UPA / Pronto Atendimento*',
  EMERGENCIA: '🏥 *Hospital / Pronto-Socorro (emergência)*',
  UBS: '🩺 *Unidade Básica de Saúde*',
};

// [FIX] Agora aceita o termo de busca, para que o link do Google Maps seja coerente
export function linkBuscaGoogleMaps(
  lat: number,
  lng: number,
  termo: string = 'UBS UPA hospital',
): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(termo)}/@${lat},${lng},14z`;
}

// [FIX] Recebe tipoBusca para escolher texto e link corretos no fallback
export function formatarUnidades(
  unidades: UnidadeSaude[],
  lat: number,
  lng: number,
  tipoBusca?: TipoBusca,
): string {
  if (unidades.length === 0) {
    const termo =
      tipoBusca === 'UBS'
        ? 'UBS posto de saúde'
        : tipoBusca === 'UPA'
        ? 'UPA 24h'
        : tipoBusca === 'HOSPITAL'
        ? 'hospital pronto socorro'
        : 'UBS UPA hospital';

    const instrucao =
      tipoBusca === 'UBS'
        ? 'Não achei a lista automática, mas você pode ver no mapa as UBS próximas:'
        : tipoBusca === 'UPA'
        ? 'Não achei a lista automática, mas você pode ver no mapa as UPAs próximas:'
        : tipoBusca === 'HOSPITAL'
        ? 'Não achei a lista automática, mas você pode ver no mapa os hospitais próximos:'
        : 'Não achei a lista automática, mas você pode ver no mapa as unidades próximas:';

    const rodape =
      tipoBusca === 'UBS'
        ? '🚨 Em caso de urgência, ligue *192* (SAMU) ou procure uma UPA 24h.'
        : '🚨 Em caso de urgência, ligue *192* (SAMU).';

    return [
      '⚠️ Não consegui localizar unidades pelo mapa automático agora.',
      '',
      `🗺️ ${instrucao}`,
      linkBuscaGoogleMaps(lat, lng, termo),
      '',
      rodape,
    ].join('\n');
  }

  const blocos: string[] = [];
  for (const cat of ['UPA', 'EMERGENCIA', 'UBS'] as CategoriaUnidade[]) {
    const doGrupo = unidades.filter((u) => u.categoria === cat);
    if (doGrupo.length === 0) continue;

    const linhas = doGrupo.map((u, i) => {
      const partes = [
        `${i + 1}. *${u.nome}*${u.publica === true ? ' (pública)' : ''}`,
        `   📏 ${formatarDistancia(u.distancia)}  •  📍 ${u.endereco}`,
      ];
      if (u.telefone) partes.push(`   📞 ${u.telefone}`);
      if (u.especializada) partes.push('   ⚠️ Atendimento especializado: confirme por telefone antes de ir.');
      partes.push(`   🗺️ ${u.linkGoogleMaps}`);
      return partes.join('\n');
    });
    blocos.push(`${TITULO[cat]}\n${linhas.join('\n\n')}`);
  }

  blocos.push('🚨 Se piorar ou ficar grave no caminho, ligue *192* (SAMU).');
  return blocos.join('\n\n');
}