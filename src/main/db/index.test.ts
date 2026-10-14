import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb, setDbPath } from './index'

describe('getDb', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('loads the sqlite-vec extension', () => {
    const { vec_version: version } = getDb().prepare('select vec_version() as vec_version').get() as {
      vec_version: string
    }
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
  })

  it('supports creating and querying a vec0 virtual table', () => {
    const db = getDb()
    db.exec('CREATE VIRTUAL TABLE t USING vec0(embedding float[4])')
    const insert = db.prepare('INSERT INTO t(rowid, embedding) VALUES (?, ?)')
    const toBuf = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer)
    insert.run(BigInt(1), toBuf([1, 0, 0, 0]))
    insert.run(BigInt(2), toBuf([0, 1, 0, 0]))

    const rows = db
      .prepare('SELECT rowid, distance FROM t WHERE embedding MATCH ? AND k = 1 ORDER BY distance')
      .all(toBuf([1, 0, 0, 0])) as { rowid: number; distance: number }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].rowid).toBe(1)
    expect(rows[0].distance).toBe(0)
  })

  describe('migrateMessagesModelColumn', () => {
    let dir: string
    let dbPath: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'sachiv-db-migration-'))
      dbPath = join(dir, 'pre-existing.db')
    })

    afterEach(async () => {
      // Closes whatever connection this test opened (setDbPath now does that itself) before the
      // temp dir is removed — otherwise deleting a file a connection still has open is a Windows
      // EBUSY (confirmed live on Windows CI), even though POSIX tolerates it silently.
      setDbPath(':memory:')
      await rm(dir, { recursive: true, force: true })
    })

    it("adds the model column to a real pre-existing database that predates it, without losing existing rows", () => {
      // Builds the exact real-world state directly: a `messages` table from before `model` existed —
      // `schema.sql`'s own `CREATE TABLE IF NOT EXISTS` would do nothing for a table that already exists,
      // so this is what the actual migration path has to handle, not a schema.sql re-run.
      const seed = new Database(dbPath)
      seed.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO sessions VALUES ('s1', 'Old session', 1000, 1000);
        INSERT INTO messages VALUES ('m1', 's1', 'user', '[{"type":"text","text":"pre-existing"}]', 1000);
      `)
      seed.close()

      setDbPath(dbPath)
      const db = getDb()

      const columns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
      expect(columns.some((c) => c.name === 'model')).toBe(true)

      const row = db.prepare('SELECT id, content, model FROM messages WHERE id = ?').get('m1') as {
        id: string
        content: string
        model: string | null
      }
      expect(row.content).toBe('[{"type":"text","text":"pre-existing"}]') // untouched
      expect(row.model).toBeNull() // new column, no value for a pre-existing row — not a parse error
    })

    it('is a no-op (does not throw, does not duplicate work) on a database that already has the column', () => {
      setDbPath(dbPath)
      getDb() // first open creates the column via schema.sql directly (fresh install path)
      setDbPath(dbPath)
      expect(() => getDb()).not.toThrow() // second open re-runs the migration check against an up-to-date table
    })
  })
})
