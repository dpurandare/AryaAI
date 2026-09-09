import { randomUUID } from 'node:crypto'
import type { DataConnectionDto, SaveDataConnectionInput, SavedQueryDto, SaveSavedQueryInput } from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { deleteApiKey, getApiKey, setApiKey } from '../security/keychain'
import { namedParamsIn } from '../tools/db/param-binding'
import { isMutatingSql } from '../tools/db/sql-classifier'

/**
 * Data-connection metadata (everything except a password) is stored as one
 * JSON array under a single settings key — the same generic key-value store
 * already used for provider/model preferences, just holding structured data
 * this time instead of a scalar. A Postgres connection's password goes
 * through the *existing* keychain store instead, keyed `db:<id>` — that
 * store already treats its key as an opaque string with no format
 * validation, so this is a pure reuse with zero code changes there.
 *
 * Saved queries live nested inside their connection's own `savedQueries`
 * array, not a separate top-level collection — deliberately, so deleting a
 * connection removes its queries just by removing the object, with no
 * separate cascade needed, and so there's no independent "all saved
 * queries" surface for a Settings UI to be built against (there isn't
 * one — see db_save_query in tools/db/save-query-tool.ts, the only writer).
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

function findConnectionDto(nameOrId: string): DataConnectionDto | undefined {
  return readList().find((c) => c.id === nameOrId || c.name === nameOrId)
}

export function listConnections(): DataConnectionDto[] {
  return readList()
}

export function saveConnection(input: SaveDataConnectionInput): DataConnectionDto {
  const list = readList()
  const id = input.id ?? randomUUID()
  // Preserve saved queries across an edit — a plain "replace the DTO"
  // would otherwise silently wipe them, since SaveDataConnectionInput has
  // no savedQueries field of its own (queries are only ever written via
  // saveSavedQuery below).
  const existingQueries = list.find((c) => c.id === id)?.savedQueries ?? []

  const dto: DataConnectionDto =
    input.engine === 'sqlite'
      ? { id, name: input.name, engine: 'sqlite', filePath: input.filePath ?? '', savedQueries: existingQueries }
      : {
          id,
          name: input.name,
          engine: 'postgres',
          host: input.host ?? '',
          port: input.port ?? 5432,
          database: input.database ?? '',
          username: input.username ?? '',
          savedQueries: existingQueries
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
  const dto = findConnectionDto(nameOrId)
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

// --- Saved queries, nested per connection ---

export function listSavedQueries(connectionNameOrId?: string): SavedQueryDto[] {
  const list = readList()
  if (connectionNameOrId) {
    return findConnectionDto(connectionNameOrId)?.savedQueries ?? []
  }
  return list.flatMap((c) => c.savedQueries ?? [])
}

/**
 * `mutates` is computed here, once, from the SQL text — not per call like
 * db_execute_sql's (which has to, since its SQL is different every time). A
 * saved query's SQL is fixed once saved; only the bound parameter values
 * change per call, so its mutating-ness is a stable property of the query
 * itself.
 *
 * Rejects a query whose SQL references a `:name` placeholder that isn't
 * declared in `params` — a saved query with an undeclared placeholder would
 * build a tool with no input field for it, then fail every single call at
 * bindNamedParams() with "missing value" instead of failing once, clearly,
 * at save time.
 */
export function saveSavedQuery(input: SaveSavedQueryInput): SavedQueryDto {
  const list = readList()
  const connIdx = list.findIndex((c) => c.id === input.connectionId || c.name === input.connectionId)
  if (connIdx === -1) {
    throw new Error(`Unknown data connection "${input.connectionId}".`)
  }

  const declaredNames = new Set(input.params.map((p) => p.name))
  const missing = namedParamsIn(input.sql).filter((name) => !declaredNames.has(name))
  if (missing.length > 0) {
    throw new Error(
      `SQL references ${missing.map((n) => `":${n}"`).join(', ')} but no matching parameter is declared.`
    )
  }

  const connection = list[connIdx]
  const id = input.id ?? randomUUID()
  const dto: SavedQueryDto = {
    id,
    connectionId: connection.id,
    name: input.name,
    description: input.description,
    sql: input.sql,
    params: input.params,
    mutates: isMutatingSql(input.sql)
  }

  const existingQueries = connection.savedQueries ?? []
  list[connIdx] = { ...connection, savedQueries: [...existingQueries.filter((q) => q.id !== id), dto] }
  writeList(list)
  return dto
}

export function deleteSavedQuery(id: string): void {
  const list = readList()
  writeList(list.map((c) => ({ ...c, savedQueries: (c.savedQueries ?? []).filter((q) => q.id !== id) })))
}
