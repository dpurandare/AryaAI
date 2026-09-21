import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const { listConnections } = await import('../../data/connections')
const { dbCreateConnectionTool } = await import('./db')

describe('db_create_connection', () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-db-create-conn-'))
    dir = await mkdtemp(join(tmpdir(), 'sachiv-db-create-conn-sqlite-'))
    dbPath = join(dir, 'real.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    seed.close()
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('always mutates, declares password as a secret field, and describes the target', () => {
    expect(dbCreateConnectionTool.mutates).toBe(true)
    expect(dbCreateConnectionTool.secretFields).toEqual(['password'])
    expect(dbCreateConnectionTool.describe?.({ name: 'X', engine: 'sqlite', filePath: 'x.db' })).toBe(
      'Create sqlite connection "X" → x.db'
    )
  })

  it('validates and creates a real sqlite connection against a real file', async () => {
    const input = { name: 'Local', engine: 'sqlite', filePath: dbPath }
    await expect(dbCreateConnectionTool.validate?.(input, {} as never)).resolves.toBeUndefined()

    const result = await dbCreateConnectionTool.execute(input, {} as never)
    expect(result).toMatch(/Created and verified data connection "Local"/)
    expect(listConnections().some((c) => c.name === 'Local' && c.engine === 'sqlite')).toBe(true)
  })

  it('rejects a sqlite path that does not exist, and does not persist anything', async () => {
    const input = { name: 'Bad', engine: 'sqlite', filePath: join(dir, 'missing.db') }
    await expect(dbCreateConnectionTool.validate?.(input, {} as never)).rejects.toThrow()
    await expect(dbCreateConnectionTool.execute(input, {} as never)).rejects.toThrow()
    expect(listConnections().some((c) => c.name === 'Bad')).toBe(false)
  })

  it('rejects an unreachable postgres host, and does not persist anything', async () => {
    const input = {
      name: 'Remote',
      engine: 'postgres',
      host: 'this-host-does-not-exist.invalid',
      port: 5432,
      database: 'db',
      username: 'user',
      password: 'pw'
    }
    await expect(dbCreateConnectionTool.execute(input, {} as never)).rejects.toThrow()
    expect(listConnections().some((c) => c.name === 'Remote')).toBe(false)
  }, 15000)

  it('rejects an unreachable mssql host, and does not persist anything', async () => {
    const input = {
      name: 'Warehouse',
      engine: 'mssql',
      host: 'this-host-does-not-exist.invalid',
      port: 1433,
      database: 'db',
      username: 'sa',
      password: 'pw'
    }
    await expect(dbCreateConnectionTool.execute(input, {} as never)).rejects.toThrow()
    expect(listConnections().some((c) => c.name === 'Warehouse')).toBe(false)
  }, 15000)
})
