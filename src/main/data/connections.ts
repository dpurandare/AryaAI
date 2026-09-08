import { randomUUID } from 'node:crypto'
import type { DataConnectionDto, SaveDataConnectionInput } from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { deleteApiKey, getApiKey, setApiKey } from '../security/keychain'

/**
 * Data-connection metadata (everything except a password) is stored as one
 * JSON array under a single settings key — the same generic key-value store
 * already used for provider/model preferences, just holding structured data
 * this time instead of a scalar. A Postgres connection's password goes
 * through the *existing* keychain store instead, keyed `db:<id>` — that
 * store already treats its key as an opaque string with no format
 * validation, so this is a pure reuse with zero code changes there.
 */
const SETTINGS_KEY = 'dataConnections'
const KEYCHAIN_PREFIX = 'db:'

export interface ResolvedSqliteConnection {
  engine: 'sqlite'
  filePath: string
}

export interface ResolvedPostgresConnection {
  engine: 'postgres'
  host: string
  port: number
  database: string
  username: string
  password: string
}

export type ResolvedConnection = ResolvedSqliteConnection | ResolvedPostgresConnection

function readList(): DataConnectionDto[] {
  const raw = getSetting(SETTINGS_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as DataConnectionDto[]
  } catch {
    return []
  }
}

function writeList(list: DataConnectionDto[]): void {
  setSetting(SETTINGS_KEY, JSON.stringify(list))
}

export function listConnections(): DataConnectionDto[] {
  return readList()
}

export function saveConnection(input: SaveDataConnectionInput): DataConnectionDto {
  const list = readList()
  const id = input.id ?? randomUUID()

  const dto: DataConnectionDto =
    input.engine === 'sqlite'
      ? { id, name: input.name, engine: 'sqlite', filePath: input.filePath ?? '' }
      : {
          id,
          name: input.name,
          engine: 'postgres',
          host: input.host ?? '',
          port: input.port ?? 5432,
          database: input.database ?? '',
          username: input.username ?? ''
        }

  if (input.engine === 'postgres' && input.password) {
    setApiKey(KEYCHAIN_PREFIX + id, input.password)
  }

  writeList([...list.filter((c) => c.id !== id), dto])
  return dto
}

export function deleteConnection(id: string): void {
  writeList(readList().filter((c) => c.id !== id))
  deleteApiKey(KEYCHAIN_PREFIX + id)
}

/** Looked up by id or by name (tools address a connection by its human-readable name). */
export function resolveConnection(nameOrId: string): ResolvedConnection | undefined {
  const dto = readList().find((c) => c.id === nameOrId || c.name === nameOrId)
  if (!dto) return undefined

  if (dto.engine === 'sqlite') {
    return { engine: 'sqlite', filePath: dto.filePath ?? '' }
  }

  return {
    engine: 'postgres',
    host: dto.host ?? '',
    port: dto.port ?? 5432,
    database: dto.database ?? '',
    username: dto.username ?? '',
    password: getApiKey(KEYCHAIN_PREFIX + dto.id) ?? ''
  }
}
