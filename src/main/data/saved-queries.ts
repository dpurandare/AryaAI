import { randomUUID } from 'node:crypto'
import type { SavedQueryDto, SaveSavedQueryInput } from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { namedParamsIn } from '../tools/db/param-binding'
import { isMutatingSql } from '../tools/db/sql-classifier'

/**
 * Same JSON-array-under-one-settings-key pattern as data/connections.ts —
 * no dedicated table, no schema migration needed, consistent with how
 * every other piece of structured app config is already stored here.
 */
const SETTINGS_KEY = 'dataSavedQueries'

function readList(): SavedQueryDto[] {
  const raw = getSetting(SETTINGS_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as SavedQueryDto[]
  } catch {
    return []
  }
}

function writeList(list: SavedQueryDto[]): void {
  setSetting(SETTINGS_KEY, JSON.stringify(list))
}

export function listSavedQueries(connectionId?: string): SavedQueryDto[] {
  const all = readList()
  return connectionId ? all.filter((q) => q.connectionId === connectionId) : all
}

export function getSavedQuery(id: string): SavedQueryDto | undefined {
  return readList().find((q) => q.id === id)
}

/**
 * `mutates` is computed here, once, from the SQL text — not per call like
 * db_execute_sql's (which has to, since its SQL is different every time).
 * A saved query's SQL is fixed once saved; only the bound parameter values
 * change per call, so its mutating-ness is a stable property of the query
 * itself.
 *
 * Rejects a query whose SQL references a `:name` placeholder that isn't
 * declared in `params` — a saved query with an undeclared placeholder
 * would build a tool with no input field for it, then fail every single
 * call at bindNamedParams() with "missing value" instead of failing once,
 * clearly, at save time.
 */
export function saveSavedQuery(input: SaveSavedQueryInput): SavedQueryDto {
  const declaredNames = new Set(input.params.map((p) => p.name))
  const missing = namedParamsIn(input.sql).filter((name) => !declaredNames.has(name))
  if (missing.length > 0) {
    throw new Error(
      `SQL references ${missing.map((n) => `":${n}"`).join(', ')} but no matching parameter is declared.`
    )
  }

  const list = readList()
  const id = input.id ?? randomUUID()
  const dto: SavedQueryDto = {
    id,
    connectionId: input.connectionId,
    name: input.name,
    description: input.description,
    sql: input.sql,
    params: input.params,
    mutates: isMutatingSql(input.sql)
  }
  writeList([...list.filter((q) => q.id !== id), dto])
  return dto
}

export function deleteSavedQuery(id: string): void {
  writeList(readList().filter((q) => q.id !== id))
}
