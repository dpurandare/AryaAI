import { resolveConnection } from '../../data/connections'
import { MssqlDriver } from './mssql-driver'
import { PostgresDriver } from './postgres-driver'
import { SqliteDriver } from './sqlite-driver'
import type { DbDriver } from './types'

/** Shared by every db_* tool (index.ts, crud.ts, saved-query-tools.ts) — one place that turns a connection name/id into a live, ready-to-use driver. */
export function openDriver(connectionNameOrId: string): DbDriver {
  const conn = resolveConnection(connectionNameOrId)
  if (!conn) {
    throw new Error(
      `Unknown data connection "${connectionNameOrId}". Call db_list_connections to see what's configured.`
    )
  }
  if (conn.engine === 'sqlite') return new SqliteDriver(conn.filePath)
  if (conn.engine === 'mssql') return new MssqlDriver(conn)
  return new PostgresDriver(conn)
}
