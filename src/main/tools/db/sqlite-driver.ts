import Database from 'better-sqlite3'
import { isMutatingSql } from './sql-classifier'
import type { DbDriver, DbQueryResult, DbTable } from './types'

const MAX_RETURNED_ROWS = 200

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export class SqliteDriver implements DbDriver {
  // better-sqlite3 is synchronous — a slow query blocks the whole Electron
  // main process (which also handles all IPC/window messaging) until it
  // returns. Acceptable for a local-first, single-user desktop app;
  // documented rather than fixed here, since fixing it needs a
  // worker_threads/utilityProcess pattern this codebase doesn't have yet.
  private readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath, { fileMustExist: true })
  }

  async introspectSchema(): Promise<DbTable[]> {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]

    return tables.map((table) => {
      const columns = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as {
        name: string
        type: string
      }[]
      return {
        name: table.name,
        columns: columns.map((c) => ({ name: c.name, type: c.type || 'unknown' }))
      }
    })
  }

  async execute(sql: string): Promise<DbQueryResult> {
    const trimmed = sql.trim()
    if (isMutatingSql(trimmed)) {
      const info = this.db.prepare(trimmed).run()
      return { rowCount: info.changes }
    }
    const rows = this.db.prepare(trimmed).all() as Record<string, unknown>[]
    return { rows: rows.slice(0, MAX_RETURNED_ROWS), rowCount: rows.length }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
