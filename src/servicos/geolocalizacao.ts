// src/servicos/geolocalizacao.ts
//
// Busca de unidades de saúde próximas via OpenStreetMap (Overpass API).
// Diferencia três categorias:
//   - UPA        → UPA 24h, Unidade de Pronto Atendimento, Pronto Atendimento (PA), CER (Rio)...
//   - EMERGENCIA → Hospital, Pronto-Socorro (PS), Santa Casa, serviço de emergência/urgência...
//   - UBS        → UBS, Clínica da Família, Posto/Centro de Saúde, Policlínica...
// Regra de ouro: para urgência, a DISTÂNCIA manda. O tipo só define o que entra na lista.

// ─────────────────────────────── Tipos ───────────────────────────────

export type CategoriaUnidade = 'UPA' | 'EMERGENCIA' | 'UBS';
// 'HOSPITAL' é aceito como apelido de 'EMERGENCIA' (compatibilidade com o bot.ts antigo)
export type TipoBusca = 'UPA' | 'EMERGENCIA' | 'HOSPITAL' | 'UBS' | 'TODOS';

export type UnidadeSaude = {
  nome: string;
  categoria: CategoriaUnidade;
  endereco: string;
  telefone: string | null;
  distancia: number; // metros, em linha reta
  lat: number;
  lng: number;
  publica: boolean | null; // null = não sei
  especializada: boolean; // ex.: hospital oftalmológico, maternidade, infantil
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

// ───────────────────────────── Configuração ──────────────────────────

const RAIOS_M = [10_000, 30_000, 60_000]; // cascata de raios
const TIMEOUT_MS = 14_000;
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT = 'DirecionaSUSBot/1.0 (contato: aisha.paola14@gmail.com)';

// Ajustes de ranking, em "metros equivalentes" somados à distância real
const PENALIDADE_ESPECIALIZADA_M = 10_000; // hospital só de olhos/maternidade etc. sem emergência
const PENALIDADE_SEM_NOME_M = 3_000; // sem nome cadastrado = menos confiável
const BONUS_PUBLICA_M = 1_000; // desempate leve a favor de unidade pública

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ─────────────────────── Classificação por nome/tags ──────────────────

// Remove acentos e pontos ("U.P.A." → "upa", "Hosp." → "hosp"), minúsculas
const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .toLowerCase()
    .trim();

// UPA "forte": nome inequívoco
const UPA_FORTE_RE =
  /\bupa\b|\bupa ?24|\bupae\b|unidade de pronto ?atendimento|unidade de pronto ?socorro|coordenacao de emergencia regional/;
// "CER" é ambíguo: no Rio = Coordenação de Emergência Regional (UPA); no SUS em geral = Centro Especializado em Reabilitação
const CER_RE = /\bcer\b/;
// UPA "fraca": termo genérico de pronto atendimento (só vale se o nome NÃO tiver "hospital")
const UPA_FRACA_RE = /pronto ?atendimento|servico de pronto|\bpa\b/;

const HOSPITAL_RE = /\bhosp(ital)?\b|santa casa|\bhps\b/;
const PRONTO_SOCORRO_RE = /pronto ?socorro|\bps\b|\bpsm\b|emergencia|urgencia/;

const UBS_RE =
  /\bubs\b|\bubsf\b|\busf\b|unidade basica|unidade de saude|clinica da familia|saude da familia|posto de saude|centro municipal de saude|centro de saude|\bcms\b|modulo do medico de familia|\bpsf\b|policlinica|atencao primaria/;

// Nunca são indicação de urgência
const EXCLUIR_RE =
  /odonto|dentist|estetic|veterinar|\bvet\b|laborator|fisioterap|psicolog|nutric|otica|fonoaudi|cosmet|\bpet\b|reabilit|centro especializado|\bcaps\b|hemodialise|dialise|radiolog|diagnostic|imagem|vacina|farmacia|drogaria|hemocentro|banco de sangue|acupuntura|pilates|academia|estacionamento|funeraria|cemiterio|\bspa\b/;

// Hospitais que atendem público restrito (só vale como penalidade, não exclui)
const ESPECIALIZADA_RE =
  /oftalm|olhos|psiquiatr|saude mental|oncolog|cancer|\binca\b|ortoped|traumato|maternidade|materno|infantil|pediatri|crianc|cardiol|geriatr|idosos|hospital dia|queimad|otorrino/;

const PUBLICA_RE =
  /municipal|estadual|federal|\bsus\b|prefeitura|secretaria|\bupa\b|\bcer\b|\bubs\b|clinica da familia|\bcms\b|universitario/;

function classificar(tags: Tags, nomeNorm: string): CategoriaUnidade | null {
  const amenity = tags.amenity ?? '';
  const healthcare = tags.healthcare ?? '';

  // Tags que descartam de cara
  if (['dentist', 'veterinary', 'pharmacy'].includes(amenity)) return null;
  if (['dentist', 'veterinary', 'pharmacy', 'laboratory', 'alternative', 'rehabilitation'].includes(healthcare))
    return null;
  if (nomeNorm && EXCLUIR_RE.test(nomeNorm)) return null;

  // Tem amenity de outro tipo (restaurante, estacionamento, escola...) e nenhuma tag de saúde: descarta
  if (amenity !== '' && healthcare === '' && !['hospital', 'clinic', 'doctors', 'social_facility'].includes(amenity))
    return null;

  const temTagSaude = ['hospital', 'clinic', 'doctors'].includes(amenity) || healthcare !== '';
  const ehHospitalTag = amenity === 'hospital' || healthcare === 'hospital' || tags.building === 'hospital';
  const urgencia24h =
    tags.emergency === 'yes' || tags.opening_hours === '24/7' || tags['healthcare:speciality'] === 'emergency';

  const cerEhUpa = CER_RE.test(nomeNorm); // já passou pelo EXCLUIR (reabilitação)
  const upaForte = UPA_FORTE_RE.test(nomeNorm) || cerEhUpa;

  // Elemento sem nenhuma tag de saúde só passa se o NOME for inequivocamente UPA
  if (!temTagSaude && !ehHospitalTag && !upaForte) return null;

  if (nomeNorm) {
    if (upaForte) return 'UPA';
    if (HOSPITAL_RE.test(nomeNorm)) return 'EMERGENCIA'; // "Pronto Atendimento do Hospital X" = hospital
    if (UPA_FRACA_RE.test(nomeNorm)) return 'UPA';
    if (PRONTO_SOCORRO_RE.test(nomeNorm)) return 'EMERGENCIA';
    if (UBS_RE.test(nomeNorm)) return 'UBS';
  }

  if (ehHospitalTag) return 'EMERGENCIA'; // hospital sem nome reconhecível
  if (amenity === 'clinic' && urgencia24h) return 'UPA'; // clínica 24h/emergência: heurística
  return null;
}

/** Exposta para testes rápidos: classifica só pelo nome. */
export function classificarPorNome(nome: string, tags: Tags = { amenity: 'clinic' }): CategoriaUnidade | null {
  return classificar(tags, norm(nome));
}

// ──────────────────────────── Overpass ───────────────────────────────

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
  // Evita ruas, pontos de ônibus, lojas etc. que só têm "Hospital" no nome
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

// Primeira promise que der certo (equivalente a Promise.any, sem exigir lib ES2021)
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
    // Dispara nos espelhos em paralelo; o mais rápido vence
    return await primeiroSucesso(MIRRORS.map((u) => consultarMirror(u, query, controller.signal)));
  } finally {
    clearTimeout(timer);
    controller.abort(); // cancela os espelhos que ficaram para trás
  }
}

const cache = new Map<string, { em: number; elementos: ElementoOsm[] }>();

// Retorna null se a consulta falhou (diferente de [] = consulta ok, mas sem resultados)
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

// ─────────────────────── Processamento e ranking ─────────────────────

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

// Distância "efetiva" usada só para ordenar. Quanto menor, melhor.
function distanciaEfetiva(u: UnidadeSaude): number {
  let d = u.distancia;
  if (u.especializada) d += PENALIDADE_ESPECIALIZADA_M;
  if (u.semNome) d += PENALIDADE_SEM_NOME_M;
  if (u.publica === true) d -= BONUS_PUBLICA_M;
  return Math.max(0, d);
}

/** Exposta para testes: transforma elementos crus do OSM em unidades classificadas e ordenadas. */
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

  // Deduplica o mesmo lugar mapeado como node + way (mesmo nome a menos de 200 m)
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

// Cascata de raios: para assim que achar ao menos uma unidade das categorias desejadas
async function buscarPorCategorias(lat: number, lng: number, desejadas: CategoriaUnidade[]): Promise<UnidadeSaude[]> {
  let ultimas: UnidadeSaude[] = [];
  for (const raio of RAIOS_M) {
    console.log(`🔍 Buscando ${desejadas.join('/')} em ${raio / 1000} km...`);
    const elementos = await obterElementos(lat, lng, raio);
    if (elementos === null) continue; // falha de rede: tenta o próximo raio
    ultimas = processarElementos(elementos, lat, lng);
    if (ultimas.some((u) => desejadas.includes(u.categoria))) break;
  }
  return ultimas;
}

// ─────────────────────────── API pública ─────────────────────────────

/**
 * Compatível com a assinatura antiga. O 4º parâmetro (raio) é ignorado: a cascata cuida disso.
 * - 'UPA'                → UPAs; se não houver nenhuma nos raios, cai para hospitais/PS
 * - 'EMERGENCIA'/'HOSPITAL' → hospitais/PS; se não houver, cai para UPAs
 * - 'UBS'                → só unidades básicas
 * - 'TODOS'              → UPAs e emergências misturadas, da mais próxima para a mais distante
 */
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

/** Uma única busca que devolve as duas listas separadas (top 2 de cada). */
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

// ───────────────────────── Formatação (WhatsApp) ─────────────────────

function formatarDistancia(metros: number): string {
  if (metros < 1000) return `${Math.max(10, Math.round(metros / 10) * 10)} m`;
  return `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
}

const TITULO: Record<CategoriaUnidade, string> = {
  UPA: '🚑 *UPA / Pronto Atendimento*',
  EMERGENCIA: '🏥 *Hospital / Pronto-Socorro (emergência)*',
  UBS: '🩺 *Unidade Básica de Saúde*',
};

export function linkBuscaGoogleMaps(lat: number, lng: number, termo = 'UPA 24h'): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(termo)}/@${lat},${lng},14z`;
}

/** Monta o texto pronto para enviar, agrupado por categoria. */
export function formatarUnidades(unidades: UnidadeSaude[], lat: number, lng: number): string {
  if (unidades.length === 0) {
    return [
      '⚠️ Não consegui localizar unidades pelo mapa agora.',
      '',
      `🗺️ Abra a busca no Google Maps:\n${linkBuscaGoogleMaps(lat, lng)}`,
      '',
      '🚨 Em caso de urgência, ligue *192* (SAMU).',
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