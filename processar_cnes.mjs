
// Lê CSVs do CNES, filtra por município + tipo de unidade,
// e gera dados/unidades_saude.json no formato que o bot espera.

import fs from 'fs';
import path from 'path';

const MUNICIPIOS = {
  '330330': 'Niterói',
  '330455': 'Rio de Janeiro',
};

const TIPOS = {
  '02': 'UBS',
  '05': 'EMERGENCIA',
  '20': 'EMERGENCIA',
  '21': 'EMERGENCIA',
  '73': 'UPA',
};

function parseCSV(texto) {
  const linhas = [];
  let linha = [];
  let campo = '';
  let dentroAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '"') {
      if (dentroAspas && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else {
        dentroAspas = !dentroAspas;
      }
    } else if (c === ';' && !dentroAspas) {
      linha.push(campo);
      campo = '';
    } else if ((c === '\n' || c === '\r') && !dentroAspas) {
      if (campo.length > 0 || linha.length > 0) {
        linha.push(campo);
        linhas.push(linha);
        linha = [];
        campo = '';
      }
    } else {
      campo += c;
    }
  }
  if (campo.length > 0 || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

function carregarCSV(caminho) {
  const buffer = fs.readFileSync(caminho);
  const texto = buffer.toString('latin1');
  const linhas = parseCSV(texto);
  if (linhas.length < 2) return [];

  const cabecalho = linhas[0].map((h) => h.trim().replace(/^"|"$/g, ''));
  return linhas.slice(1).map((linha) => {
    const obj = {};
    cabecalho.forEach((col, i) => {
      obj[col] = (linha[i] ?? '').trim().replace(/^"|"$/g, '');
    });
    return obj;
  });
}

const cacheGeo = new Map();
let ultimaChamada = 0;

async function geocodificar(endereco) {
  if (!endereco || endereco.length < 5) return null;
  if (cacheGeo.has(endereco)) return cacheGeo.get(endereco);

  const espera = ultimaChamada + 1100 - Date.now();
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaChamada = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(endereco)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'DirecionaSUSBot-import/1.0 (contato: aisha.paola14@gmail.com)' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      cacheGeo.set(endereco, null);
      return null;
    }
    const { lat, lon } = data[0];
    const coords = { lat: parseFloat(lat), lng: parseFloat(lon) };
    if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return null;
    cacheGeo.set(endereco, coords);
    return coords;
  } catch {
    return null;
  }
}

async function main() {
  const pasta = process.argv[2] ?? './cnes_raw';
  const pathEstab = path.join(pasta, 'tbEstabelecimento.csv');

  if (!fs.existsSync(pathEstab)) {
    console.error(`❌ Arquivo não encontrado: ${pathEstab}`);
    console.error('   Extraia o ZIP do CNES nessa pasta.');
    process.exit(1);
  }

  console.log(`📂 Lendo ${pathEstab}...`);
  const estabelecimentos = carregarCSV(pathEstab);
  console.log(`   ${estabelecimentos.length} estabelecimentos no total`);

  // Descobre nomes de colunas (variam entre versões do CNES)
  const amostra = estabelecimentos[0] ?? {};
   const colMun = ['CO_MUNICIPIO_GESTOR', 'CODUFMUN', 'COD_UFMUN', 'CO_MUNICIPIO'].find((c) => c in amostra);
  const colTipo = ['TP_UNIDADE', 'COD_TIPO_ESTAB', 'CO_TIPO_UNIDADE'].find((c) => c in amostra);
  const colNome = ['NO_FANTASIA', 'NOME_FANTASIA', 'NO_ESTAB', 'NOME_ESTABELECIMENTO'].find((c) => c in amostra);
  const colLat = ['NU_LATITUDE', 'LATITUDE'].find((c) => c in amostra);
  const colLng = ['NU_LONGITUDE', 'LONGITUDE'].find((c) => c in amostra);
  const colRua = ['NO_LOGRADOURO', 'DS_ENDERECO'].find((c) => c in amostra);
  const colNum = ['NU_ENDERECO'].find((c) => c in amostra);
  const colBairro = ['NO_BAIRRO'].find((c) => c in amostra);
  const colTel = ['NU_TELEFONE', 'TELEFONE'].find((c) => c in amostra);
  if (!colMun || !colTipo || !colNome) {
    console.error('❌ Colunas obrigatórias não encontradas no CSV.');
    console.error('   Total de colunas:', Object.keys(amostra).length);
    console.error('   Colunas disponíveis:');
    Object.keys(amostra).forEach((c) => console.error(`      - ${c}`));
    process.exit(1);
  }
  console.log(`   Colunas: mun=${colMun}, tipo=${colTipo}, nome=${colNome}`);

  const filtrados = estabelecimentos.filter((e) => {
    const codMun = String(e[colMun] ?? '').substring(0, 6);
    const codTipo = String(e[colTipo] ?? '').padStart(2, '0').substring(0, 2);
    return MUNICIPIOS[codMun] && TIPOS[codTipo];
  });

  console.log(`✅ ${filtrados.length} estabelecimentos passaram no filtro`);

  const unidades = [];
  let contadorGeo = 0;
  let aproveitados = 0;

  for (const e of filtrados) {
    const codTipo = String(e[colTipo] ?? '').padStart(2, '0').substring(0, 2);
    const categoria = TIPOS[codTipo];

    const nome = String(e[colNome] ?? '').trim();
    if (!nome) continue;

    let lat = parseFloat(colLat ? e[colLat] : '');
    let lng = parseFloat(colLng ? e[colLng] : '');

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      const rua = colRua ? e[colRua] : '';
      const num = colNum ? e[colNum] : '';
      const bairro = colBairro ? e[colBairro] : '';
      const municipio = MUNICIPIOS[String(e[colMun] ?? '').substring(0, 6)];
      const enderecoCompleto = `${nome}, ${rua} ${num}, ${bairro}, ${municipio}, RJ, Brasil`;

      contadorGeo++;
      if (contadorGeo % 10 === 0) {
        console.log(`   Geocodificando ${contadorGeo}...`);
      }

      const coords = await geocodificar(enderecoCompleto);
      if (!coords) continue;
      lat = coords.lat;
      lng = coords.lng;
    } else {
      aproveitados++;
    }

    const rua = colRua ? e[colRua] : '';
    const num = colNum ? e[colNum] : 's/n';
    const bairro = colBairro ? e[colBairro] : '';
    const municipio = MUNICIPIOS[String(e[colMun] ?? '').substring(0, 6)];
    const endereco = `${rua}, ${num} - ${bairro}, ${municipio}`.replace(/\s+/g, ' ').trim();

    const tel = String(colTel ? e[colTel] : '').split(',')[0].replace(/\D/g, '').trim();

    unidades.push({
      nome,
      categoria,
      endereco,
      telefone: tel ? `(${tel.slice(0, 2)}) ${tel.slice(2, 6)}-${tel.slice(6)}` : null,
      lat,
      lng,
      publica: true,
    });
  }

  console.log(`📦 ${unidades.length} unidades com coordenadas`);
  console.log(`   (${aproveitados} já vinham com lat/lng no CNES)`);

  const vistos = new Set();
  const unicas = unidades.filter((u) => {
    const chave = `${u.nome}|${u.lat.toFixed(4)}|${u.lng.toFixed(4)}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });

  console.log(`🔍 ${unicas.length} unidades únicas`);

  const porCat = {
    UPA: unicas.filter((u) => u.categoria === 'UPA').length,
    EMERGENCIA: unicas.filter((u) => u.categoria === 'EMERGENCIA').length,
    UBS: unicas.filter((u) => u.categoria === 'UBS').length,
  };
  console.log(`   UPA: ${porCat.UPA}, Hospital: ${porCat.EMERGENCIA}, UBS: ${porCat.UBS}`);

  const saida = {
    atualizado_em: new Date().toISOString().slice(0, 10),
    fonte: 'CNES',
    municipios: Object.values(MUNICIPIOS),
    unidades: unicas,
  };

  const destino = path.resolve(process.cwd(), 'dados', 'unidades_saude.json');
  if (!fs.existsSync(path.dirname(destino))) fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify(saida, null, 2), 'utf-8');

  console.log(`\n✅ Salvo em ${destino}`);
  console.log(`   Tamanho: ${(fs.statSync(destino).size / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});