
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { inicializarTabelaEstado } from './persistencia_estado.js';

const AUTH_DIR = 'auth_info_baileys';
const SESSION_ID = 'direciona-sus-bot';

export type Sql = ReturnType<typeof postgres>;

export async function criarClienteDb(): Promise<Sql | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('⚠️ DATABASE_URL não definida. Sessão NÃO será persistida.');
    return null;
  }

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

  // [Bloco 2] Cria a tabela de estado da conversa na mesma conexão
  await inicializarTabelaEstado(sql);

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

const jaEnviado = new Map<string, string>();
let sincronizando = false;

export async function subirSessaoParaBanco(sql: Sql | null): Promise<void> {
  if (!sql) return;
  if (!fs.existsSync(AUTH_DIR)) return;
  if (sincronizando) return;
  sincronizando = true;

  try {
    const arquivos = fs.readdirSync(AUTH_DIR).filter((a) => a.endsWith('.json'));

    for (const arq of arquivos) {
      try {
        const conteudo = fs.readFileSync(path.join(AUTH_DIR, arq), 'utf-8');
        if (jaEnviado.get(arq) === conteudo) continue;
        await sql`
          INSERT INTO bot_sessions (session_id, file_name, content)
          VALUES (${SESSION_ID}, ${arq}, ${conteudo})
          ON CONFLICT (session_id, file_name)
          DO UPDATE SET content = ${conteudo}, updated_at = NOW()
        `;
        jaEnviado.set(arq, conteudo);
      } catch (err) {
        console.error(`❌ Erro ao salvar ${arq}:`, err);
      }
    }

    const locais = new Set(arquivos);
    if (!locais.has('creds.json')) return;
    const remotos = (await sql`
      SELECT file_name FROM bot_sessions WHERE session_id = ${SESSION_ID}
    `) as Array<{ file_name: string }>;
    for (const { file_name } of remotos) {
      if (!locais.has(file_name)) {
        await sql`DELETE FROM bot_sessions WHERE session_id = ${SESSION_ID} AND file_name = ${file_name}`;
        jaEnviado.delete(file_name);
      }
    }
  } finally {
    sincronizando = false;
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

/**
 * Apaga a sessão do WhatsApp (disco + banco). Usado quando o WhatsApp desconecta o aparelho:
 * sem isso, todo restart restaura a mesma sessão inválida e o bot nunca volta a gerar QR Code.
 */
export async function apagarSessao(sql: Sql | null): Promise<void> {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  jaEnviado.clear();
  if (!sql) return;
  try {
    await sql`DELETE FROM bot_sessions WHERE session_id = ${SESSION_ID}`;
  } catch (err) {
    console.error('❌ Erro ao apagar sessão do banco:', err);
  }
}

/**
 * No SIGTERM/SIGINT: salva a sessão, fecha a conexão e SAI do processo.
 * Ter um listener de SIGTERM desliga a saída padrão do Node; sem o process.exit,
 * a instância antiga continuava conectada durante o deploy e brigava com a nova
 * pela mesma sessão do WhatsApp (uma derruba a outra, e o bot "sai do ar").
 */
export function registrarSyncNoShutdown(sql: Sql | null, fecharConexao: () => void): void {
  let saindo = false;
  const handler = async (signal: string) => {
    if (saindo) return;
    saindo = true;
    console.log(`\n🛑 Recebido ${signal}, salvando sessão antes de sair...`);
    const limite = setTimeout(() => process.exit(0), 8000);
    limite.unref?.();
    try {
      fecharConexao();
      await subirSessaoParaBanco(sql);
      console.log('✅ Sessão salva no banco.');
    } catch (err) {
      console.error('❌ Erro ao salvar sessão no shutdown:', err);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}