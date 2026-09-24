export interface DbColumn {
  name: string
  type: string
}

export interface DbTable {
  name: string
  columns: DbColumn[]
}

export interface DbQueryResult {
  /** Present for a read; omitted for a write, where rowCount is the affected-row count instead. */
  rows?: Record<string, unknown>[]
  rowCount: number
}

export interface DbDriver {
  /** Which positional placeholder style execute()'s params bind against — needed by callers (saved-query-tools.ts, crud.ts) that build parameterized/paginated SQL before calling execute(). */
  readonly engine: 'sqlite' | 'postgres' | 'mssql' | 'mysql'
  introspectSchema(): Promise<DbTable[]>
  /** `params` are bound positionally (`?` for SQLite, `$1..$n` for Postgres) — never string-interpolated into `sql`. */
  execute(sql: string, params?: unknown[]): Promise<DbQueryResult>
  close(): Promise<void>
}
