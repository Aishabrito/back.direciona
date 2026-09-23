// src/servicos/geolocalizacao.ts
import fs from 'fs';
import path from 'path';

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

// [FIX Bloco 1] Tempos de espera reduzidos: falha rápido em vez de deixar
// o usuário esperando 60s. Cascata local → OSM → Google resolve o resto.
const RAIOS_M = [8_000, 25_000];
const TIMEOUT_MS = 9_000;
const ORCAMENTO_TOTAL_MS = 16_000;
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
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
  /\bubs\b|\bubsf\b|\busf\b|unidade basica|unidade de saude|clinica da familia|saude da familia|posto de saude|centro municipal de saude|centro de saude|\bcms\b|modulo do medico de familia|\bpsf\b|policlinica|atencao primaria|modulo (do )?(programa )?medico|programa medico de familia|medico de familia|\bpmf\b/;
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
    '(^|[ -])CMS([ -]|$)',
    '(^|[ -])PMF([ -]|$)',
    'M.dulo (do )?(Programa )?M.dico',
    'M.dico de Fam.lia',
  ].join('|');
  const semRuido = '[!"highway"][!"railway"][!"public_transport"][!"shop"][!"leisure"][!"tourism"][!"landuse"][!"barrier"]';

  return `[out:json][timeout:20];
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

type BuscaOsm = { unidades: UnidadeSaude[]; sucessos: number; falhas: number };

async function buscarOsm(lat: number, lng: number, primarias: CategoriaUnidade[]): Promise<BuscaOsm> {
  const inicio = Date.now();
  let unidades: UnidadeSaude[] = [];
  let sucessos = 0;
  let falhas = 0;
  for (const raio of RAIOS_M) {
    if (Date.now() - inicio > ORCAMENTO_TOTAL_MS) break;
    console.log(`🔍 Overpass ${primarias.join('/')} em ${raio / 1000} km...`);
    const elementos = await obterElementos(lat, lng, raio);
    if (elementos === null) { falhas++; continue; }
    sucessos++;
    unidades = processarElementos(elementos, lat, lng);
    if (unidades.some((u) => primarias.includes(u.categoria))) break;
  }
  return { unidades, sucessos, falhas };
}

// ────────────────────────────────────────────────────────────
// Base local curada (opcional) — CNES ou exportação manual.
// Arquivo padrão: dados/unidades_saude.json (ou env UNIDADES_JSON).
// Formato:
//   { "atualizado_em": "2026-03-15", "unidades": [
//       { "nome": "...", "categoria": "UPA"|"EMERGENCIA"|"UBS",
//         "endereco": "...", "telefone": "...", "lat": -22.9, "lng": -43.1,
//         "publica": true } ] }
// Aceita também o formato antigo (array direto) para retrocompatibilidade.
// ────────────────────────────────────────────────────────────
type UnidadeLocal = {
  nome: string; categoria: CategoriaUnidade; endereco?: string;
  telefone?: string | null; lat: number; lng: number; publica?: boolean | null;
};
let baseLocal: UnidadeLocal[] | null = null;


function carregarBaseLocal(): UnidadeLocal[] {
  if (baseLocal !== null) return baseLocal;

  try {
    const caminho = process.env.UNIDADES_JSON ?? path.resolve(process.cwd(), 'dados', 'unidades_saude.json');
    if (!fs.existsSync(caminho)) {
      baseLocal = [];
      return baseLocal;
    }

    const bruto = JSON.parse(fs.readFileSync(caminho, 'utf-8'));

    // Aceita os 2 formatos: array direto (antigo) ou { atualizado_em, unidades } (novo)
    const lista = Array.isArray(bruto) ? bruto : (bruto.unidades ?? []);

    if (!Array.isArray(bruto) && typeof bruto.atualizado_em === 'string') {
      const idadeDias = (Date.now() - new Date(bruto.atualizado_em).getTime()) / (24 * 3600 * 1000);
      if (idadeDias > 180) {
        console.warn(`⚠️ Base local de unidades desatualizada há ${Math.round(idadeDias)} dias. Reimporte do CNES.`);
      }
    }

    const filtrado: UnidadeLocal[] = lista.filter((u: any) =>
      u && Number.isFinite(u.lat) && Number.isFinite(u.lng) &&
      ['UPA', 'EMERGENCIA', 'UBS'].includes(u.categoria) &&
      typeof u.nome === 'string');

    console.log(`📚 Base local de unidades: ${filtrado.length} registros.`);
    baseLocal = filtrado;
    return baseLocal;
  } catch (err) {
    console.error('❌ Erro lendo base local de unidades:', err);
    baseLocal = [];
    return baseLocal;
  }
}
function buscarLocal(lat: number, lng: number, raioMax = 30_000): UnidadeSaude[] {
  return carregarBaseLocal()
    .map((u): UnidadeSaude => ({
      nome: u.nome, categoria: u.categoria, endereco: u.endereco || 'Endereço não informado',
      telefone: u.telefone ?? null, distancia: calcularDistancia(lat, lng, u.lat, u.lng),
      lat: u.lat, lng: u.lng, publica: u.publica ?? null, especializada: false, semNome: false,
      linkGoogleMaps: `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${u.lat},${u.lng}`,
    }))
    .filter((u) => u.distancia <= raioMax)
    .sort((a, b) => a.distancia - b.distancia);
}

export type TipoUsuario = 'UPA' | 'HOSPITAL' | 'UBS';

async function buscarGoogle(lat: number, lng: number, tipo: TipoUsuario): Promise<UnidadeSaude[] | null> {
  const chave = process.env.GOOGLE_PLACES_API_KEY;
  if (!chave) return null;
  const consulta =
    tipo === 'UBS' ? 'UBS posto de saúde clínica da família'
    : tipo === 'UPA' ? 'UPA 24 horas pronto atendimento'
    : 'hospital pronto socorro emergência';
  const padrao: CategoriaUnidade = tipo === 'UBS' ? 'UBS' : tipo === 'UPA' ? 'UPA' : 'EMERGENCIA';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': chave,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.googleMapsUri',
      },
      body: JSON.stringify({
        textQuery: consulta, languageCode: 'pt-BR', regionCode: 'BR', maxResultCount: 8,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 20_000 } },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { places?: any[] };
    const lista: UnidadeSaude[] = [];
    for (const p of data.places ?? []) {
      const nome: string = p.displayName?.text ?? '';
      const pLat: number | undefined = p.location?.latitude;
      const pLng: number | undefined = p.location?.longitude;
      if (!nome || pLat == null || pLng == null) continue;
      if (EXCLUIR_RE.test(norm(nome))) continue;
      lista.push({
        nome, categoria: classificarPorNome(nome) ?? padrao,
        endereco: p.formattedAddress ?? 'Endereço não informado', telefone: null,
        distancia: calcularDistancia(lat, lng, pLat, pLng), lat: pLat, lng: pLng,
        publica: PUBLICA_RE.test(norm(nome)) ? true : null, especializada: false, semNome: false,
        linkGoogleMaps: p.googleMapsUri ?? `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${pLat},${pLng}`,
      });
    }
    return lista.sort((a, b) => a.distancia - b.distancia);
  } catch (err) {
    console.error('❌ Google Places falhou:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type ResultadoBusca = {
  unidades: UnidadeSaude[];
  origem: 'local' | 'osm' | 'google' | 'nenhuma';
  falhaServico: boolean;
};

function selecionar(todas: UnidadeSaude[], tipo: TipoUsuario): UnidadeSaude[] {
  const por = (c: CategoriaUnidade) => todas.filter((u) => u.categoria === c);
  if (tipo === 'UBS') return por('UBS').slice(0, 5);
  if (tipo === 'UPA') {
    const upas = por('UPA');
    return (upas.length > 0 ? upas : por('EMERGENCIA')).slice(0, 5);
  }
  return [...por('EMERGENCIA').slice(0, 3), ...por('UPA').slice(0, 2)];
}

export async function buscarUnidades(lat: number, lng: number, tipo: TipoUsuario): Promise<ResultadoBusca> {
  const primarias: CategoriaUnidade[] =
    tipo === 'UBS' ? ['UBS'] : tipo === 'UPA' ? ['UPA'] : ['EMERGENCIA'];

  const local = selecionar(buscarLocal(lat, lng), tipo);
  if (local.some((u) => primarias.includes(u.categoria))) {
    return { unidades: local, origem: 'local', falhaServico: false };
  }

  const osm = await buscarOsm(lat, lng, primarias);
  const doOsm = selecionar(osm.unidades, tipo);
  if (doOsm.some((u) => primarias.includes(u.categoria))) {
    return { unidades: doOsm, origem: 'osm', falhaServico: false };
  }

  const google = await buscarGoogle(lat, lng, tipo);
  if (google && google.length > 0) {
    return {
      unidades: selecionar(google, tipo).length ? selecionar(google, tipo) : google.slice(0, 5),
      origem: 'google',
      falhaServico: false,
    };
  }

  const sobra = doOsm.length ? doOsm : local;
  const todasFalharam = osm.sucessos === 0 && google === null;
  return {
    unidades: sobra,
    origem: sobra.length ? (doOsm.length ? 'osm' : 'local') : 'nenhuma',
    falhaServico: sobra.length === 0 && todasFalharam,
  };
}

export async function buscarUnidadesProximas(
  lat: number, lng: number, tipo: TipoBusca = 'TODOS', _raioIgnorado?: number,
): Promise<UnidadeSaude[]> {
  const t: TipoUsuario = tipo === 'UBS' ? 'UBS' : tipo === 'UPA' ? 'UPA' : 'HOSPITAL';
  return (await buscarUnidades(lat, lng, t)).unidades;
}

export async function buscarUpaEEmergencia(
  lat: number, lng: number,
): Promise<{ upas: UnidadeSaude[]; emergencias: UnidadeSaude[] }> {
  const { unidades } = await buscarUnidades(lat, lng, 'HOSPITAL');
  return {
    upas: unidades.filter((u) => u.categoria === 'UPA'),
    emergencias: unidades.filter((u) => u.categoria === 'EMERGENCIA'),
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

export function linkBuscaGoogleMaps(
  lat: number,
  lng: number,
  termo: string = 'UBS UPA hospital',
): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(termo)}/@${lat},${lng},14z`;
}

export function formatarUnidades(
  unidades: UnidadeSaude[],
  lat: number,
  lng: number,
  tipoBusca?: TipoBusca,
  opcoes: { falhaServico?: boolean } = {},
): string {
  if (unidades.length === 0) {
    const termo =
      tipoBusca === 'UBS' ? 'UBS posto de saúde'
      : tipoBusca === 'UPA' ? 'UPA 24h'
      : tipoBusca === 'HOSPITAL' ? 'hospital pronto socorro'
      : 'UBS UPA hospital';

    const instrucao =
      tipoBusca === 'UBS' ? 'Não achei a lista automática, mas você pode ver no mapa as UBS próximas:'
      : tipoBusca === 'UPA' ? 'Não achei a lista automática, mas você pode ver no mapa as UPAs próximas:'
      : tipoBusca === 'HOSPITAL' ? 'Não achei a lista automática, mas você pode ver no mapa os hospitais próximos:'
      : 'Não achei a lista automática, mas você pode ver no mapa as unidades próximas:';

    const rodape =
      tipoBusca === 'UBS' ? '🚨 Em caso de urgência, ligue *192* (SAMU) ou procure uma UPA 24h.'
      : '🚨 Em caso de urgência, ligue *192* (SAMU).';

    const aviso = opcoes.falhaServico
      ? '⚠️ O serviço de mapas está instável agora e não consegui montar a lista.'
      : '⚠️ Não encontrei unidades cadastradas perto desse ponto.';

    return [aviso, '', `🗺️ ${instrucao}`, linkBuscaGoogleMaps(lat, lng, termo), '', rodape].join('\n');
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