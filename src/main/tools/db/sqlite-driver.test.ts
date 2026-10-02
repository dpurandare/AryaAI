import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteDriver } from './sqlite-driver'

describe('SqliteDriver', () => {
  let dir: string
  let dbPath: string
  let driver: SqliteDriver

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sachiv-sqlite-driver-'))
    dbPath = join(dir, 'test.db')
    const seed = new Database(dbPath)
    seed.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
      INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com'), ('Grace', 'grace@example.com');
    `)
    seed.close()
    driver = new SqliteDriver(dbPath)
  })

  afterEach(async () => {
    await driver.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('introspects tables and columns', async () => {
    const tables = await driver.introspectSchema()
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('users')
    expect(tables[0].columns.map((c) => c.name)).toEqual(['id', 'name', 'email'])
  })

  it('reads rows for a SELECT', async () => {
    const result = await driver.execute('SELECT name FROM users ORDER BY name')
    expect(result.rows).toEqual([{ name: 'Ada' }, { name: 'Grace' }])
    expect(result.rowCount).toBe(2)
  })

  it('returns well over the old 200-row UX cap for a genuinely large result, not silently truncated (TASKS #172)', async () => {
    const seed = new Database(dbPath)
    const insert = seed.prepare('INSERT INTO users (name) VALUES (?)')
    const insertMany = seed.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`user-${i}`)
    })
    insertMany(5000)
    seed.close()

    const result = await driver.execute('SELECT name FROM users')
    // 5000 new + the 2 seeded in beforeEach.
    expect(result.rowCount).toBe(5002)
    expect(result.rows).toHaveLength(5002) // not capped at 200 — the real data is all there
  })

  it('writes and reports the affected row count', async () => {
    const result = await driver.execute("INSERT INTO users (name) VALUES ('Katherine')")
    expect(result.rows).toBeUndefined()
    expect(result.rowCount).toBe(1)

    const after = await driver.execute('SELECT COUNT(*) as n FROM users')
    expect(after.rows).toEqual([{ n: 3 }])
  })

  it('refuses to open a file that does not exist', () => {
    expect(() => new SqliteDriver(join(dir, 'missing.db'))).toThrow()
  })

  it('sets a 5s busy_timeout, so a connection external to this app briefly holding the file does not fail the query outright', async () => {
    // Regression guard for the value itself (better-sqlite3 already
    // defaults to this — see sqlite-driver.ts's comment — this just makes
    // sure nothing here accidentally overrides it to 0/unset).
    const result = await driver.execute('PRAGMA busy_timeout')
    expect(result.rows).toEqual([{ timeout: 5000 }])
  })
})
