import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const { setDbPath } = await import('../../db')
const { saveConnection, getConnection } = await import('../../data/connections')
const { dbListConnectionsTool, dbIntrospectSchemaTool, dbExecuteSqlTool } = await import('./index')
const { WorkspaceGuard } = await import('../../security/workspace-guard')

// These tools ignore ctx, but Tool.execute's signature requires one. A real
// OS-native path, not a hand-built one — see workspace-guard.test.ts.
const ctx = { workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-db-tools-root')), currentSessionId: 'test-session' }

describe('db_* tools', () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-db-tools-userdata-'))
    dir = await mkdtemp(join(tmpdir(), 'sachiv-db-tools-'))
    dbPath = join(dir, 'app.db')
    const seed = new Database(dbPath)
    seed.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO users (name) VALUES ('Ada'), ('Grace');
    `)
    seed.close()
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('db_list_connections reports none configured', async () => {
    expect(await dbListConnectionsTool.execute({}, ctx)).toMatch(/No data connections configured/)
  })

  it('db_list_connections lists a configured connection with no schema hint yet', async () => {
    saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    expect(await dbListConnectionsTool.execute({}, ctx)).toBe('- "Local" (sqlite): (schema not yet known)')
  })

  it('db_list_connections shows the cached table-name hint once one exists', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    const { updateConnectionSchemaSummary } = await import('../../data/connections')
    updateConnectionSchemaSummary(conn.id, { tables: ['users', 'orders'], truncated: false, updatedAt: 0 })
    expect(await dbListConnectionsTool.execute({}, ctx)).toBe('- "Local" (sqlite): users, orders')
  })

  it('db_introspect_schema describes tables and columns', async () => {
    saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    const result = await dbIntrospectSchemaTool.execute({ connection: 'Local' }, ctx)
    expect(result).toContain('users(id: INTEGER, name: TEXT)')
  })

  it('db_introspect_schema opportunistically caches a table-name summary for db_list_connections to use later', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    expect(getConnection(conn.id)?.schemaSummary).toBeUndefined()

    await dbIntrospectSchemaTool.execute({ connection: 'Local' }, ctx)

    expect(getConnection(conn.id)?.schemaSummary?.tables).toEqual(['users'])
  })

  it('db_introspect_schema errors clearly for an unknown connection', async () => {
    await expect(dbIntrospectSchemaTool.execute({ connection: 'nope' }, ctx)).rejects.toThrow(
      /Unknown data connection "nope"/
    )
  })

  it('db_execute_sql runs a read and returns rows', async () => {
    saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    const result = await dbExecuteSqlTool.execute({ connection: 'Local', sql: 'SELECT name FROM users ORDER BY name' }, ctx)
    expect(result).toContain('2 row(s):')
    expect(result).toContain('Ada')
    expect(result).toContain('Grace')
  })

  it('db_execute_sql runs a write and reports the affected count', async () => {
    saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    const result = await dbExecuteSqlTool.execute({
      connection: 'Local',
      sql: "INSERT INTO users (name) VALUES ('Katherine')"
    }, ctx)
    expect(result).toBe('1 row(s) affected.')
  })

  it('db_execute_sql.mutates classifies reads and writes correctly', () => {
    const mutates = dbExecuteSqlTool.mutates as (input: Record<string, unknown>) => boolean
    expect(mutates({ sql: 'SELECT * FROM users' })).toBe(false)
    expect(mutates({ sql: "DELETE FROM users WHERE name = 'x'" })).toBe(true)
  })

  it('db_execute_sql.describe shows the literal SQL for the confirmation dialog', () => {
    expect(dbExecuteSqlTool.describe?.({ connection: 'Local', sql: 'DELETE FROM users' })).toBe(
      'Execute SQL on "Local": DELETE FROM users'
    )
  })
})
