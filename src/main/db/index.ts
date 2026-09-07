import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
// eslint-disable-next-line import/no-unresolved
import schema from './schema.sql?raw'

let db: Database.Database | undefined

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = join(app.getPath('userData'), 'sachiv.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec(schema)
  }
  return db
}
