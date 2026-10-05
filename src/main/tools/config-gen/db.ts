import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DbEngine, SaveDataConnectionInput } from '@shared/ipc-contract'
import { saveConnection } from '../../data/connections'
import { MssqlDriver } from '../db/mssql-driver'
import { MysqlDriver } from '../db/mysql-driver'
import { PostgresDriver } from '../db/postgres-driver'
import { SqliteDriver } from '../db/sqlite-driver'
import type { DbDriver } from '../db/types'
import type { Tool, ToolContext } from '../types'

/**
 * Maps what a model or user actually says to the stored engine id. Found live: the Settings dropdown labels the
 * engine "SQL Server", the model passed that label through, and the tool rejected it as an unknown engine even
 * though the user had named a supported one. Matching ignores case, spaces and punctuation ("SQL Server",
 * "sql-server", "Microsoft SQL Server", "PostgreSQL", "MariaDB" all resolve). Unrecognised input is returned
 * unchanged, so the caller's "unknown engine" error still names exactly what was given.
 */
const ENGINE_ALIASES: Record<string, DbEngine> = {
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  psql: 'postgres',
  mssql: 'mssql',
  sqlserver: 'mssql',
  microsoftsqlserver: 'mssql',
  msqlserver: 'mssql',
  tsql: 'mssql',
  azuresql: 'mssql',
  mysql: 'mysql',
  mariadb: 'mysql'
}

export function normalizeEngine(raw: unknown): string {
  const text = String(raw ?? '').trim()
  return ENGINE_ALIASES[text.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? text
}

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git'])
const MAX_WORKSPACE_MATCHES = 5

/**
 * Recursively finds every file named `filename` under `root` — skipping
 * node_modules/.git and any other dot-directory — capped at
 * MAX_WORKSPACE_MATCHES so a common filename can't run away scanning a
 * large workspace (we only need to know "one match" vs "ambiguous" vs
 * "none", not every occurrence).
 */
function findInWorkspace(root: string, filename: string): string[] {
  const matches: string[] = []
  const dirs = [root]
  while (dirs.length > 0 && matches.length < MAX_WORKSPACE_MATCHES) {
    const dir = dirs.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !IGNORED_DIR_NAMES.has(entry.name)) {
          dirs.push(join(dir, entry.name))
        }
      } else if (entry.name === filename) {
        matches.push(join(dir, entry.name))
      }
    }
  }
  return matches
}

/**
 * Resolves a model/user-given sqlite path to a real file on disk:
 *  - An exact path that exists (absolute, or relative to this process) is
 *    used as-is — sqlite connections are deliberately not confined to the
 *    workspace the way read_file/write_file are, since "add my existing
 *    database" means a file that already lives wherever the user's other
 *    app put it, anywhere on disk.
 *  - Anything else — no path given, or one that doesn't resolve (the
 *    session-observed failure mode: a model handing over a
 *    workspace-relative guess like "data/foo.db" instead of the real
 *    absolute path the user typed) — falls back to a recursive search of
 *    the workspace for a file with that basename, so a partial/wrong path
 *    still finds the file instead of failing with a cryptic driver error
 *    ("Cannot open database because the directory does not exist").
 */
function resolveSqliteFilePath(rawPath: string, workspaceRoot: string): string {
  const trimmed = rawPath.trim()
  if (trimmed && existsSync(trimmed)) return resolve(trimmed)

  const filename = trimmed ? basename(trimmed) : ''
  if (!filename) {
    throw new Error('No sqlite file path given — provide the full path to the .db file.')
  }

  const matches = findInWorkspace(workspaceRoot, filename)
  if (matches.length === 0) {
    throw new Error(
      `"${trimmed}" doesn't exist, and no file named "${filename}" was found anywhere in the workspace ` +
        `(${workspaceRoot}). Give the full, absolute path to the file.`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `"${filename}" isn't a full path, and more than one file with that name exists in the workspace: ` +
        `${matches.join(', ')}. Give the full path to the one you mean.`
    )
  }
  return matches[0]
}

/**
 * Builds a driver directly from raw input fields, not via
 * data/connections.ts's resolveConnection (which reads a *saved*
 * connection by id) — validation has to run before anything is persisted.
 * Returns the resolved sqlite file path (undefined for other engines) so
 * callers persist the path that was actually verified, not necessarily the
 * raw one the model passed in.
 */
async function probeConnection(input: Record<string, unknown>, ctx: ToolContext): Promise<string | undefined> {
  const engine = normalizeEngine(input.engine) as DbEngine
  let driver: DbDriver
  let resolvedFilePath: string | undefined
  if (engine === 'sqlite') {
    resolvedFilePath = resolveSqliteFilePath(String(input.filePath ?? ''), ctx.workspaceGuard.root)
    driver = new SqliteDriver(resolvedFilePath)
  } else if (engine === 'postgres' || engine === 'mssql' || engine === 'mysql') {
    const defaultPort = { postgres: 5432, mssql: 1433, mysql: 3306 }[engine]
    const config = {
      host: String(input.host ?? ''),
      port: Number(input.port ?? defaultPort),
      database: String(input.database ?? ''),
      username: String(input.username ?? ''),
      password: String(input.password ?? '')
    }
    if (engine === 'postgres') driver = new PostgresDriver(config)
    else if (engine === 'mssql') driver = new MssqlDriver(config)
    else driver = new MysqlDriver(config)
  } else {
    throw new Error(`Unknown engine "${engine}" — must be "sqlite", "postgres", "mssql" (SQL Server), or "mysql".`)
  }
  try {
    await driver.introspectSchema()
  } finally {
    await driver.close()
  }
  return resolvedFilePath
}

export const dbCreateConnectionTool: Tool = {
  name: 'db_create_connection',
  description:
    'Create a new Database connection (Settings > Data sources) directly from details gathered in chat, ' +
    "instead of asking the user to fill out the Settings form by hand. Gather the non-secret fields " +
    "yourself (host/port/database/username for postgres/mssql/mysql, filePath for sqlite); the connection's " +
    "password (postgres/mssql/mysql only) is entered by the user directly in the confirmation dialog, never " +
    "typed to you — never ask the user to tell you their password in chat. The connection is real-tested " +
    "(a genuine schema probe) before being saved, so a bad host/credential is caught immediately, not " +
    "discovered later.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      engine: { type: 'string', enum: ['sqlite', 'postgres', 'mssql', 'mysql'] },
      filePath: {
        type: 'string',
        description:
          'sqlite only: absolute path to an existing .sqlite/.db file, exactly as given by the user — ' +
          'NOT relative to the workspace root (unlike read_file/write_file/list_directory). This file can ' +
          'live anywhere on disk.'
      },
      host: { type: 'string', description: 'postgres/mssql/mysql only' },
      port: { type: 'number', description: 'postgres/mssql/mysql only, default 5432/1433/3306' },
      database: { type: 'string', description: 'postgres/mssql/mysql only' },
      username: { type: 'string', description: 'postgres/mssql/mysql only' },
      password: { type: 'string', description: 'postgres/mssql/mysql only — the user enters this directly, do not ask for it in chat' }
    },
    required: ['name', 'engine']
  },
  mutates: true,
  secretFields: ['password'],
  describe(input) {
    const engine = normalizeEngine(input.engine)
    const target = engine === 'sqlite' ? String(input.filePath ?? '') : `${String(input.host ?? '')}/${String(input.database ?? '')}`
    return `Create ${engine} connection "${String(input.name ?? '')}" → ${target}`
  },
  validate: async (input, ctx) => {
    await probeConnection(input, ctx)
  },
  async execute(input, ctx) {
    const resolvedFilePath = await probeConnection(input, ctx)
    const saveInput: SaveDataConnectionInput = {
      name: String(input.name ?? ''),
      engine: normalizeEngine(input.engine) as DbEngine,
      filePath: resolvedFilePath ?? (typeof input.filePath === 'string' ? input.filePath : undefined),
      host: typeof input.host === 'string' ? input.host : undefined,
      port: typeof input.port === 'number' ? input.port : undefined,
      database: typeof input.database === 'string' ? input.database : undefined,
      username: typeof input.username === 'string' ? input.username : undefined,
      password: typeof input.password === 'string' ? input.password : undefined
    }
    const saved = saveConnection(saveInput)
    return `Created and verified data connection "${saved.name}". It now appears in Settings > Data sources and is usable via db_list_connections.`
  }
}
