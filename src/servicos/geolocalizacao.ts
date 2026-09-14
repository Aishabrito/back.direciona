// src/servicos/geolocalizacao.ts

export type UnidadeSaude = {
  nome: string;
  endereco: string;
  distancia: number; // em metros
  lat: number;
  lng: number;
  linkGoogleMaps: string;
};

/**
 * Busca unidades de saúde públicas (hospitais, UPAs, UBS) próximas a uma localização.
 * @param lat Latitude
 * @param lng Longitude
 * @param tipo 'UPA' | 'HOSPITAL' | 'UBS' | 'TODOS'
 * @param raioEmMetros Raio de busca (padrão 5000m = 5km)
 */
export async function buscarUnidadesProximas(
  lat: number,
  lng: number,
  tipo: 'UPA' | 'HOSPITAL' | 'UBS' | 'TODOS' = 'TODOS',
  raioEmMetros: number = 5000,
): Promise<UnidadeSaude[]> {
  // Monta a query Overpass conforme o tipo
  let filtros = '';

  if (tipo === 'UPA') {
    // UPAs geralmente são marcadas como clinic com "UPA" no nome, ou healthcare=clinic
    filtros = `
      node["amenity"="clinic"](around:${raioEmMetros},${lat},${lng});
      node["healthcare"="clinic"](around:${raioEmMetros},${lat},${lng});
      node["amenity"="hospital"][name~"UPA"](around:${raioEmMetros},${lat},${lng});
    `;
  } else if (tipo === 'HOSPITAL') {
    filtros = `
      node["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
      way["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
    `;
  } else if (tipo === 'UBS') {
    filtros = `
      node["amenity"="clinic"][name~"UBS"](around:${raioEmMetros},${lat},${lng});
      node["healthcare"="clinic"][name~"UBS"](around:${raioEmMetros},${lat},${lng});
      node["amenity"="hospital"][name~"UBS"](around:${raioEmMetros},${lat},${lng});
    `;
  } else {
    // TODOS: busca tudo e filtra depois
    filtros = `
      node["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
      node["amenity"="clinic"](around:${raioEmMetros},${lat},${lng});
      node["healthcare"="clinic"](around:${raioEmMetros},${lat},${lng});
      way["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
    `;
  }

  const overpassQuery = `
    [out:json];
    (
      ${filtros}
    );
    out center;
  `;

  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!data.elements || data.elements.length === 0) {
      return [];
    }

    const resultados: UnidadeSaude[] = [];

    for (const el of data.elements) {
      // Pega coordenadas (pode vir em lat/lon ou center)
      const elLat = el.lat || el.center?.lat || 0;
      const elLon = el.lon || el.center?.lon || 0;

      if (elLat === 0 || elLon === 0) continue;

      const nome = el.tags?.name || 'Unidade de Saúde';
      const endereco = el.tags?.['addr:street'] || el.tags?.['addr:full'] || 'Endereço não informado';
      const distancia = calcularDistancia(lat, lng, elLat, elLon);

      // Filtra por nome para priorizar públicas (se não tiver nome, mantém)
      const nomeLower = nome.toLowerCase();
      const isPublica =
        nomeLower.includes('sus') ||
        nomeLower.includes('upa') ||
        nomeLower.includes('ubs') ||
        nomeLower.includes('municipal') ||
        nomeLower.includes('estadual') ||
        nomeLower.includes('hospital público') ||
        nomeLower.includes('público');

      // Se for específico, aplica filtro; senão, aceita tudo
      if (tipo === 'UPA' && !nomeLower.includes('upa')) continue;
      if (tipo === 'UBS' && !nomeLower.includes('ubs')) continue;

      resultados.push({
        nome,
        endereco,
        distancia,
        lat: elLat,
        lng: elLon,
        linkGoogleMaps: `https://www.google.com/maps/dir/${lat},${lng}/${elLat},${elLon}`,
      });
    }

    // Ordena por distância e retorna os 3 mais próximos
    resultados.sort((a, b) => a.distancia - b.distancia);

    // Se não encontrou nenhuma pública, mas encontrou privadas, retorna as privadas com aviso
    const publicas = resultados.filter(r => r.nome.toLowerCase().includes('sus') || r.nome.toLowerCase().includes('upa') || r.nome.toLowerCase().includes('ubs'));
    if (publicas.length > 0) {
      return publicas.slice(0, 3);
    }

    // Se não achou pública, retorna as mais próximas com aviso (mas ainda úteis)
    return resultados.slice(0, 3);
  } catch (error) {
    console.error('Erro ao buscar unidades no Overpass:', error);
    return [];
  }
}

// Cálculo de distância Haversine (em metros)
function calcularDistancia(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}