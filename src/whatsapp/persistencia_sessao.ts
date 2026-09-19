// src/whatsapp/persistencia_sessao.ts
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';

const AUTH_DIR = 'auth_info_baileys';
const SESSION_ID = 'direciona-sus-bot';

export type Sql = ReturnType<typeof postgres>;

export async function criarClienteDb(): Promise<Sql | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('⚠️ DATABASE_URL não definida. Sessão NÃO será persistida.');
    return null;
  }

  // [FIX] Pool pequeno: o Supabase Session Pooler limita a 15 conexões no total.
  // Com max: 2, sobra espaço para outras ferramentas.
  const sql = postgres(connectionString, {
    ssl: 'require',
    max: 2,
    idle_timeout: 20,
    connect_timeout: 15,
  });

  await sql`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      session_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (session_id, file_name)
    )
  `;

  console.log('✅ Tabela bot_sessions pronta.');
  return sql;
}

export async function baixarSessaoParaDisco(sql: Sql | null): Promise<void> {
  if (!sql) return;

  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const linhas = (await sql`
    SELECT file_name, content FROM bot_sessions
    WHERE session_id = ${SESSION_ID}
  `) as Array<{ file_name: string; content: string }>;

  if (linhas.length === 0) {
    console.log('ℹ️ Nenhuma sessão encontrada no banco. Será gerado novo QR Code.');
    return;
  }

  for (const linha of linhas) {
    fs.writeFileSync(path.join(AUTH_DIR, linha.file_name), linha.content, 'utf-8');
  }

  console.log(`✅ Sessão restaurada do banco: ${linhas.length} arquivos.`);
}

export async function subirSessaoParaBanco(sql: Sql | null): Promise<void> {
  if (!sql) return;
  if (!fs.existsSync(AUTH_DIR)) return;

  const arquivos = fs.readdirSync(AUTH_DIR).filter((a) => a.endsWith('.json'));

  for (const arq of arquivos) {
    try {
      const conteudo = fs.readFileSync(path.join(AUTH_DIR, arq), 'utf-8');
      await sql`
        INSERT INTO bot_sessions (session_id, file_name, content)
        VALUES (${SESSION_ID}, ${arq}, ${conteudo})
        ON CONFLICT (session_id, file_name)
        DO UPDATE SET content = ${conteudo}, updated_at = NOW()
      `;
    } catch (err) {
      console.error(`❌ Erro ao salvar ${arq}:`, err);
    }
  }
}

export function iniciarSyncPeriodico(sql: Sql | null): NodeJS.Timeout | null {
  if (!sql) return null;
  return setInterval(() => {
    subirSessaoParaBanco(sql).catch((err) =>
      console.error('❌ Erro no sync periódico:', err),
    );
  }, 30_000);
}

export function registrarSyncNoShutdown(sql: Sql | null): void {
  if (!sql) return;
  const handler = async (signal: string) => {
    console.log(`\n🛑 Recebido ${signal}, salvando sessão antes de sair...`);
    try {
      await subirSessaoParaBanco(sql);
      console.log('✅ Sessão salva no banco.');
    } catch (err) {
      console.error('❌ Erro ao salvar sessão no shutdown:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}