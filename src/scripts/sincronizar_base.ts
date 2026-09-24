// src/scripts/sincronizar_base.ts
// Sincroniza base_conhecimento.json com a tabela do Supabase.
// - Pula tópicos que JÁ têm embedding no banco (economiza quota)
// - Retry automático quando bate no rate limit do Gemini (429)
// - Idempotente: pode rodar várias vezes sem duplicar

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import postgres from 'postgres';
import { gerarEmbedding } from '../servicos/embeddings.js';

const DIMENSAO = 768;
const DELAY_ENTRE_REQUESTS_MS = 700; // ~85/min, abaixo do limite de 100/min
const MAX_TENTATIVAS = 5;

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrapper com retry no embedding: se bater 429, espera e tenta de novo.
async function gerarEmbeddingComRetry(texto: string, idTopico: string): Promise<number[] | null> {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const vetor = await gerarEmbedding(texto);
    if (vetor && vetor.length > 0) return vetor;

    // Se falhou, espera com backoff exponencial
    const espera = Math.min(60_000, 10_000 * tentativa);
    console.warn(
      `⏳ ${idTopico} — falhou (tentativa ${tentativa}/${MAX_TENTATIVAS}). ` +
      `Aguardando ${Math.round(espera / 1000)}s...`,
    );
    await dormir(espera);
  }
  return null;
}

async function main() {
  // ── 1. Carrega JSON
  const basePath = path.join(process.cwd(), 'src', 'regras', 'base_conhecimento.json');
  if (!fs.existsSync(basePath)) {
    console.error(`❌ Arquivo não encontrado: ${basePath}`);
    process.exit(1);
  }

  const base = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
  const topicos: Array<{ id: string; titulo: string; tags: string[]; conteudo: string }> =
    base.topicos ?? [];

  console.log(`📚 ${topicos.length} tópicos no JSON`);

  // ── 2. Conecta
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL não definida.');
    process.exit(1);
  }

  const sql = postgres(connectionString, { ssl: 'require', max: 1, idle_timeout: 20 });

  // ── 3. Extensão + tabela
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  const info = (await sql`
    SELECT format_type(atttypid, atttypmod) AS tipo
    FROM pg_attribute
    WHERE attrelid = 'base_conhecimento'::regclass
      AND attname = 'embedding'
  `) as Array<{ tipo: string }>;

  if (info.length > 0) {
    const tipoAtual = info[0].tipo;
    if (!tipoAtual.includes(`(${DIMENSAO})`)) {
      console.warn(`⚠️  Recriando coluna embedding (atual: ${tipoAtual}, nova: vector(${DIMENSAO}))`);
      await sql`ALTER TABLE base_conhecimento DROP COLUMN embedding`;
      await sql`ALTER TABLE base_conhecimento ADD COLUMN embedding vector(${sql.unsafe(String(DIMENSAO))})`;
      console.log(`✅ Coluna recriada.`);
    } else {
      console.log(`ℹ️  Tabela já em vector(${DIMENSAO}).`);
    }
  } else {
    await sql`
      CREATE TABLE IF NOT EXISTS base_conhecimento (
        id TEXT PRIMARY KEY,
        titulo TEXT NOT NULL,
        conteudo TEXT NOT NULL,
        embedding vector(${sql.unsafe(String(DIMENSAO))})
      )
    `;
    console.log(`✅ Tabela criada.`);
  }

  // ── 4. Descobre quem já tem embedding (pra pular)
  const jaTem = (await sql`
    SELECT id FROM base_conhecimento WHERE embedding IS NOT NULL
  `) as Array<{ id: string }>;
  const setJaTem = new Set(jaTem.map((r) => r.id));

  const paraFazer = topicos.filter((t) => !setJaTem.has(t.id));
  const pulados = topicos.length - paraFazer.length;

  console.log(`📊 ${pulados} já têm embedding, ${paraFazer.length} para processar.`);

  if (paraFazer.length === 0) {
    console.log(`\n✅ Nada a fazer. Base já está completa.`);
    await sql.end();
    return;
  }

  // ── 5. Sincroniza
  let ok = 0;
  let falhou = 0;

  for (const topico of paraFazer) {
    try {
      const textoEmbedding = `${topico.titulo}\n\n${topico.tags.join(', ')}\n\n${topico.conteudo}`;

      const vetor = await gerarEmbeddingComRetry(textoEmbedding, topico.id);
      if (!vetor) {
        console.error(`❌ ${topico.id} — falhou após ${MAX_TENTATIVAS} tentativas`);
        falhou++;
        continue;
      }

      const vetorStr = `[${vetor.join(',')}]`;

      await sql`
        INSERT INTO base_conhecimento (id, titulo, conteudo, embedding)
        VALUES (${topico.id}, ${topico.titulo}, ${topico.conteudo}, ${vetorStr}::vector)
        ON CONFLICT (id) DO UPDATE
        SET titulo = EXCLUDED.titulo,
            conteudo = EXCLUDED.conteudo,
            embedding = EXCLUDED.embedding
      `;

      ok++;
      console.log(`   ✅ ${ok}/${paraFazer.length} — ${topico.id}`);

      // Delay entre requests pra respeitar o rate limit
      if (ok < paraFazer.length) await dormir(DELAY_ENTRE_REQUESTS_MS);
    } catch (err: any) {
      console.error(`❌ ${topico.id}: ${err?.message || err}`);
      falhou++;
    }
  }

  // ── 6. Remove órfãos
  const idsNoJson = topicos.map((t) => t.id);
  const removidos = await sql`
    DELETE FROM base_conhecimento
    WHERE id NOT IN ${sql(idsNoJson)}
    RETURNING id
  `;
  if (removidos.length > 0) {
    console.log(`🧹 ${removidos.length} órfãos removidos.`);
  }

  // ── 7. Resumo
  console.log(`\n✅ Sincronização concluída`);
  console.log(`   Já tinha: ${pulados}`);
  console.log(`   Inseridos/atualizados agora: ${ok}`);
  console.log(`   Falhas: ${falhou}`);

  await sql.end();
}

main().catch((err) => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});