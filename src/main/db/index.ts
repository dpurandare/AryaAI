import Database from 'better-sqlite3'
// eslint-disable-next-line import/no-unresolved
import schema from './schema.sql?raw'

let db: Database.Database | undefined
let dbPath: string | undefined

/**
 * Sets where the database lives and resets any already-open connection so
 * the next getDb() call opens fresh at the new path. Deliberately has no
 * Electron dependency (no `app.getPath` call here) — the real path is set
 * once from src/main/index.ts before registerIpcHandlers() runs, and tests
 * set it to ':memory:' for a fully isolated, in-memory database per test.
 * Keeping this file Electron-free is what makes it importable under plain
 * Vitest at all: a top-level `import { app } from 'electron'` crashes at
 * module-evaluation time outside a real Electron process, before any
 * function body (including a guard inside getDb()) ever runs.
 */
export function setDbPath(path: string): void {
  dbPath = path
  db = undefined
}

export function getDb(): Database.Database {
  if (!db) {
    if (!dbPath) {
      throw new Error('Database path not set — call setDbPath() first.')
    }
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec(schema)
  }
  return db
}
