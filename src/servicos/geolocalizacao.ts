// src/servicos/geolocalizacao.ts

export type UnidadeSaude = {
  nome: string;
  endereco: string;
  distancia: number;
  lat: number;
  lng: number;
  linkGoogleMaps: string;
};

export async function buscarUnidadesProximas(
  lat: number,
  lng: number,
  tipo: 'UPA' | 'HOSPITAL' | 'UBS' | 'TODOS' = 'TODOS',
  raioEmMetros: number = 5000,
): Promise<UnidadeSaude[]> {
  // [FIX 14] regex Overpass agora é case-insensitive com `,i`
  let filtros = '';

  if (tipo === 'UPA') {
    filtros = `
      node["amenity"="clinic"](around:${raioEmMetros},${lat},${lng});
      node["healthcare"="clinic"](around:${raioEmMetros},${lat},${lng});
      node["amenity"="hospital"]["name"~"UPA",i](around:${raioEmMetros},${lat},${lng});
    `;
  } else if (tipo === 'HOSPITAL') {
    filtros = `
      node["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
      way["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
    `;
  } else if (tipo === 'UBS') {
    filtros = `
      node["amenity"="clinic"]["name"~"UBS",i](around:${raioEmMetros},${lat},${lng});
      node["healthcare"="clinic"]["name"~"UBS",i](around:${raioEmMetros},${lat},${lng});
    `;
  } else {
    filtros = `
      node["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
      node["amenity"="clinic"](around:${raioEmMetros},${lat},${lng});
      node["healthcare"="clinic"](around:${raioEmMetros},${lat},${lng});
      way["amenity"="hospital"](around:${raioEmMetros},${lat},${lng});
    `;
  }

  const overpassQuery = `[out:json];(${filtros});out center;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.elements || data.elements.length === 0) return [];

    const resultados: UnidadeSaude[] = [];

    for (const el of data.elements) {
      const elLat = el.lat || el.center?.lat || 0;
      const elLon = el.lon || el.center?.lon || 0;
      if (elLat === 0 || elLon === 0) continue;

      const nome = el.tags?.name || 'Unidade de Saúde';
      const endereco = el.tags?.['addr:street'] || el.tags?.['addr:full'] || 'Endereço não informado';
      const distancia = calcularDistancia(lat, lng, elLat, elLon);
      const nomeLower = nome.toLowerCase();

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

    resultados.sort((a, b) => a.distancia - b.distancia);

    const publicas = resultados.filter(
      (r) =>
        r.nome.toLowerCase().includes('sus') ||
        r.nome.toLowerCase().includes('upa') ||
        r.nome.toLowerCase().includes('ubs'),
    );

    return (publicas.length > 0 ? publicas : resultados).slice(0, 3);
  } catch (error) {
    console.error('Erro ao buscar unidades no Overpass:', error);
    return [];
  }
}

function calcularDistancia(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}