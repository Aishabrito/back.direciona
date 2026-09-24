
import fs from 'fs';
import path from 'path';
import postgres from 'postgres';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const dbUrl = process.env.DATABASE_URL;

if (!apiKey || !dbUrl) {
  console.error('❌ Faltando GEMINI_API_KEY ou DATABASE_URL no .env');
  console.error('   Confirma que o .env tem essas duas variáveis.');
  process.exit(1);
}

const sql = postgres(dbUrl, { ssl: 'require', max: 2 });
const ai = new GoogleGenAI({ apiKey });

async function embedding(texto) {
  const resp = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: texto.slice(0, 2000),
    config: { outputDimensionality: 768 },
  });
  return resp.embeddings?.[0]?.values ?? null;
}
async function main() {
  const caminho = path.resolve('src', 'regras', 'base_conhecimento.json');
  if (!fs.existsSync(caminho)) {
    console.error('❌ Não achei', caminho);
    process.exit(1);
  }

  const dados = JSON.parse(fs.readFileSync(caminho, 'utf-8'));
  const topicos = dados.topicos ?? [];
  console.log(`📚 ${topicos.length} tópicos para indexar\n`);

  let ok = 0;
  let erro = 0;

  for (let i = 0; i < topicos.length; i++) {
    const t = topicos[i];
    const texto = `${t.titulo}\n${(t.tags ?? []).join(', ')}\n${t.conteudo}`;

    process.stdout.write(
      `   [${String(i + 1).padStart(3)}/${topicos.length}] ${t.titulo.slice(0, 55)}... `,
    );

    try {
      const vetor = await embedding(texto);
      if (!vetor) {
        console.log('❌ sem vetor');
        erro++;
        continue;
      }

      const vetorStr = `[${vetor.join(',')}]`;

      await sql`
        INSERT INTO base_conhecimento (id, titulo, tags, conteudo, embedding, atualizado_em)
        VALUES (${t.id}, ${t.titulo}, ${t.tags ?? []}, ${t.conteudo}, ${vetorStr}::vector, NOW())
        ON CONFLICT (id) DO UPDATE SET
          titulo = ${t.titulo},
          tags = ${t.tags ?? []},
          conteudo = ${t.conteudo},
          embedding = ${vetorStr}::vector,
          atualizado_em = NOW()
      `;
      console.log('✅');
      ok++;

      // Free tier: 1500 req/min. 50ms entre chamadas é folga.
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      console.log('❌', err.message);
      erro++;
    }
  }

  console.log(`\n✅ ${ok} indexados, ${erro} falhas`);
  await sql.end();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});