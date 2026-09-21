import type { DbEngine, SaveDataConnectionInput } from '@shared/ipc-contract'
import { saveConnection } from '../../data/connections'
import { PostgresDriver } from '../db/postgres-driver'
import { SqliteDriver } from '../db/sqlite-driver'
import type { DbDriver } from '../db/types'
import type { Tool } from '../types'

/**
 * Builds a driver directly from raw input fields, not via
 * data/connections.ts's resolveConnection (which reads a *saved*
 * connection by id) — validation has to run before anything is persisted.
 */
async function probeConnection(input: Record<string, unknown>): Promise<void> {
  const engine = String(input.engine ?? '') as DbEngine
  let driver: DbDriver
  if (engine === 'sqlite') {
    driver = new SqliteDriver(String(input.filePath ?? ''))
  } else if (engine === 'postgres') {
    driver = new PostgresDriver({
      host: String(input.host ?? ''),
      port: Number(input.port ?? 5432),
      database: String(input.database ?? ''),
      username: String(input.username ?? ''),
      password: String(input.password ?? '')
    })
  } else {
    throw new Error(`Unknown engine "${engine}" — must be "sqlite" or "postgres".`)
  }
  try {
    await driver.introspectSchema()
  } finally {
    await driver.close()
  }
}

export const dbCreateConnectionTool: Tool = {
  name: 'db_create_connection',
  description:
    'Create a new Database connection (Settings > Data sources) directly from details gathered in chat, ' +
    "instead of asking the user to fill out the Settings form by hand. Gather the non-secret fields " +
    "yourself (host/port/database/username for postgres, filePath for sqlite); the connection's password " +
    "(postgres only) is entered by the user directly in the confirmation dialog, never typed to you — " +
    'never ask the user to tell you their password in chat. The connection is real-tested (a genuine ' +
    "schema probe) before being saved, so a bad host/credential is caught immediately, not discovered later.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      engine: { type: 'string', enum: ['sqlite', 'postgres'] },
      filePath: { type: 'string', description: 'sqlite only: path to an existing .sqlite/.db file' },
      host: { type: 'string', description: 'postgres only' },
      port: { type: 'number', description: 'postgres only, default 5432' },
      database: { type: 'string', description: 'postgres only' },
      username: { type: 'string', description: 'postgres only' },
      password: { type: 'string', description: 'postgres only — the user enters this directly, do not ask for it in chat' }
    },
    required: ['name', 'engine']
  },
  mutates: true,
  secretFields: ['password'],
  describe(input) {
    const engine = String(input.engine ?? '')
    const target = engine === 'sqlite' ? String(input.filePath ?? '') : `${String(input.host ?? '')}/${String(input.database ?? '')}`
    return `Create ${engine} connection "${String(input.name ?? '')}" → ${target}`
  },
  validate: probeConnection,
  async execute(input) {
    await probeConnection(input)
    const saveInput: SaveDataConnectionInput = {
      name: String(input.name ?? ''),
      engine: String(input.engine ?? '') as DbEngine,
      filePath: typeof input.filePath === 'string' ? input.filePath : undefined,
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
