
// Converte endereço/bairro em coordenadas via Nominatim (OpenStreetMap).

export type CoordenadasTexto = {
  lat: number;
  lng: number;
  display: string;
};

const USER_AGENT = 'DirecionaSUSBot/1.0 (contato: aisha.paola14@gmail.com)';

export async function buscarCoordenadasPorTexto(
  endereco: string,
): Promise<CoordenadasTexto | null> {
  const termo = endereco.trim();
  if (termo.length < 3) return null;

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(termo)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;

    const data = (await resp.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!Array.isArray(data) || data.length === 0) return null;

    const item = data[0];
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng, display: item.display_name };
  } catch (err) {
    clearTimeout(timer);
    console.error('❌ Nominatim falhou:', err);
    return null;
  }
}