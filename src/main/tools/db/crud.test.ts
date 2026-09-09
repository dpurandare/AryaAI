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
const { saveConnection } = await import('../../data/connections')
const { dbListRowsTool, dbCountRowsTool, dbFindRowsTool } = await import('./crud')
const { WorkspaceGuard } = await import('../../security/workspace-guard')

const ctx = { workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-db-crud-root')), currentSessionId: 'test-session' }

describe('db_list_rows / db_count_rows / db_find_rows', () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-db-crud-userdata-'))
    dir = await mkdtemp(join(tmpdir(), 'sachiv-db-crud-'))
    dbPath = join(dir, 'app.db')
    const seed = new Database(dbPath)
    seed.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT);
      INSERT INTO users (name, status) VALUES ('Ada', 'active'), ('Grace', 'active'), ('Bob', 'inactive');
    `)
    seed.close()
    saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('db_list_rows lists all rows with default paging', async () => {
    const result = await dbListRowsTool.execute({ connection: 'Local', table: 'users' }, ctx)
    expect(result).toContain('3 row(s):')
    expect(result).toContain('Ada')
    expect(result).toContain('Bob')
  })

  it('db_list_rows respects limit/offset', async () => {
    const result = await dbListRowsTool.execute({ connection: 'Local', table: 'users', limit: 1, offset: 1 }, ctx)
    expect(result).toContain('1 row(s):')
    expect(result).toContain('Grace')
    expect(result).not.toContain('Ada')
  })

  it('db_list_rows errors clearly for an unknown table instead of running any SQL', async () => {
    await expect(dbListRowsTool.execute({ connection: 'Local', table: 'ghosts' }, ctx)).rejects.toThrow(
      /Unknown table "ghosts"/
    )
  })

  it('db_count_rows counts all rows', async () => {
    expect(await dbCountRowsTool.execute({ connection: 'Local', table: 'users' }, ctx)).toBe('3')
  })

  it('db_find_rows finds rows matching one column', async () => {
    const result = await dbFindRowsTool.execute(
      { connection: 'Local', table: 'users', column: 'status', value: 'active' },
      ctx
    )
    expect(result).toContain('2 row(s):')
    expect(result).toContain('Ada')
    expect(result).toContain('Grace')
    expect(result).not.toContain('Bob')
  })

  it('db_find_rows errors clearly for an unknown column instead of running any SQL', async () => {
    await expect(
      dbFindRowsTool.execute({ connection: 'Local', table: 'users', column: 'ghost_col', value: 'x' }, ctx)
    ).rejects.toThrow(/no column "ghost_col"/)
  })

  it('all three are non-mutating', () => {
    expect(dbListRowsTool.mutates).toBe(false)
    expect(dbCountRowsTool.mutates).toBe(false)
    expect(dbFindRowsTool.mutates).toBe(false)
  })
})
