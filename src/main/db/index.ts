import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
// eslint-disable-next-line import/no-unresolved
import schema from './schema.sql?raw'

/**
 * sqlite-vec resolves its native binary's path via require.resolve()/
 * import.meta.resolve() (electron-builder.yml's asarUnpack physically copies
 * the file to app.asar.unpacked, but neither resolver knows to redirect
 * there — that redirect is a special case Electron's require() only applies
 * to .node native-addon files it loads itself via dlopen, not to arbitrary
 * resolved asset paths a *caller* is going to dlopen through a separate
 * mechanism, i.e. better-sqlite3's db.loadExtension()). Confirmed live in a
 * real packaged app: it tried to dlopen a path still inside app.asar, which
 * doesn't exist as a real file, and doubling as SQLite's own suffix-retry
 * fallback in the error message. Fix: take whatever path sqlite-vec resolves
 * and rewrite it to its real, unpacked location before loading.
 */
const sqliteVec = createRequire(import.meta.url)('sqlite-vec') as typeof import('sqlite-vec')

function resolveLoadableVecPath(): string {
  const resolved = sqliteVec.getLoadablePath()
  // Handles both path separators — the packaged app runs on mac/win/linux.
  return resolved.replace(/\.asar([\\/])/, '.asar.unpacked$1')
}

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
  // Close any previously-open connection before discarding the reference — just dropping it
  // leaked the native OS file handle. POSIX tolerates that (unlinking an open file works fine),
  // which is why this went unnoticed until the first real Windows CI run: Windows refuses to
  // delete a file a process still has open, so a test re-pointing setDbPath at a new temp dir and
  // then cleaning up the old one hit "EBUSY: resource busy or locked" on the leaked handle.
  db?.close()
  dbPath = path
  db = undefined
}

/**
 * `schema.sql`'s `CREATE TABLE IF NOT EXISTS` is naturally idempotent for a brand-new table, but adds
 * nothing to a `messages` table that already exists on disk from before a column was added — SQLite (and
 * this codebase, which has no prior migration of this kind) has no `ADD COLUMN IF NOT EXISTS`, so this
 * checks `PRAGMA table_info` directly and only runs `ALTER TABLE` when the column is genuinely missing.
 * A fresh install never hits the `ALTER TABLE` branch at all (the column is already in `schema.sql`).
 */
function migrateMessagesModelColumn(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  if (!columns.some((c) => c.name === 'model')) {
    database.exec('ALTER TABLE messages ADD COLUMN model TEXT')
  }
}

export function getDb(): Database.Database {
  if (!db) {
    if (!dbPath) {
      throw new Error('Database path not set — call setDbPath() first.')
    }
    db = new Database(dbPath)
    db.loadExtension(resolveLoadableVecPath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec(schema)
    migrateMessagesModelColumn(db)
  }
  return db
}
