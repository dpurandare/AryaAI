import Database from 'better-sqlite3'
import { quoteIdentifier } from './identifier'
import { isMutatingSql } from './sql-classifier'
import type { DbDriver, DbQueryResult, DbTable } from './types'

const MAX_RETURNED_ROWS = 200

export class SqliteDriver implements DbDriver {
  readonly engine = 'sqlite' as const

  // better-sqlite3 is synchronous — a slow query blocks the whole Electron
  // main process (which also handles all IPC/window messaging) until it
  // returns. Acceptable for a local-first, single-user desktop app;
  // documented rather than fixed here, since fixing it needs a
  // worker_threads/utilityProcess pattern this codebase doesn't have yet.
  private readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath, { fileMustExist: true })
    // Explicit, not just relying on it: better-sqlite3 already defaults
    // `timeout` (its constructor option for PRAGMA busy_timeout) to 5000ms
    // internally (lib/database.js) — confirmed live against a real
    // contended file, not assumed, and this line changes nothing about
    // actual behavior today. Written anyway so the requirement is visible
    // in this file and doesn't silently break if that default ever changes
    // upstream. Two connections from *this* app can never actually collide
    // on each other regardless — Node is single-threaded and nothing here
    // holds a transaction open across an await, so one connection's
    // synchronous statement always fully completes before another can
    // start. What a busy_timeout actually guards against is a real
    // *external* writer to the same file — another program, another tool,
    // a second instance of this app pointed at the same data connection.
    // Deliberately NOT forcing `journal_mode = WAL` here, unlike the app's
    // own db: that's a permanent, on-disk change to the *user's* file
    // (extra -wal/-shm companion files, different behavior for whatever
    // other tools they already use on it) — not something to impose as a
    // side effect of running a query they asked for.
    this.db.pragma('busy_timeout = 5000')
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

  async execute(sql: string, params: unknown[] = []): Promise<DbQueryResult> {
    const trimmed = sql.trim()
    if (isMutatingSql(trimmed)) {
      const info = this.db.prepare(trimmed).run(...params)
      return { rowCount: info.changes }
    }
    const rows = this.db.prepare(trimmed).all(...params) as Record<string, unknown>[]
    return { rows: rows.slice(0, MAX_RETURNED_ROWS), rowCount: rows.length }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
