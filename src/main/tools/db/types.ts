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
  introspectSchema(): Promise<DbTable[]>
  execute(sql: string): Promise<DbQueryResult>
  close(): Promise<void>
}
