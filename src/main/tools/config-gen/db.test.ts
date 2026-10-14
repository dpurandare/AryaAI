import Database from 'better-sqlite3'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'

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
const { dbCreateConnectionTool, normalizeEngine } = await import('./db')

function makeCtx(workspaceRoot: string): ToolContext {
  return { workspaceGuard: new WorkspaceGuard(workspaceRoot), currentSessionId: '' }
}

describe('db_create_connection', () => {
  let dir: string
  let dbPath: string
  let workspaceDir: string

  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-db-create-conn-'))
    // Outside the workspace entirely — models the real EnergyAIProto2 case:
    // an existing .db file that lives wherever the user's other app put it,
    // not inside this app's own workspace folder.
    dir = await mkdtemp(join(tmpdir(), 'sachiv-db-create-conn-sqlite-'))
    dbPath = join(dir, 'real.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    seed.close()
    workspaceDir = await mkdtemp(join(tmpdir(), 'sachiv-db-create-conn-workspace-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('always mutates, declares password as a secret field, and describes the target', () => {
    expect(dbCreateConnectionTool.mutates).toBe(true)
    expect(dbCreateConnectionTool.secretFields).toEqual(['password'])
    expect(dbCreateConnectionTool.describe?.({ name: 'X', engine: 'sqlite', filePath: 'x.db' })).toBe(
      'Create sqlite connection "X" → x.db'
    )
  })

  it('uses an exact, existing path as-is even when it lives outside the workspace', async () => {
    const ctx = makeCtx(workspaceDir)
    const input = { name: 'Local', engine: 'sqlite', filePath: dbPath }
    await expect(dbCreateConnectionTool.validate?.(input, ctx)).resolves.toBeUndefined()

    const result = await dbCreateConnectionTool.execute(input, ctx)
    expect(result).toMatch(/Created and verified data connection "Local"/)
    const saved = listConnections().find((c) => c.name === 'Local' && c.engine === 'sqlite')
    expect(saved?.filePath).toBe(dbPath)
  })

  it('rejects a sqlite path that does not exist and has no match in the workspace, and does not persist anything', async () => {
    const ctx = makeCtx(workspaceDir)
    const input = { name: 'Bad', engine: 'sqlite', filePath: join(dir, 'missing.db') }
    await expect(dbCreateConnectionTool.validate?.(input, ctx)).rejects.toThrow()
    await expect(dbCreateConnectionTool.execute(input, ctx)).rejects.toThrow()
    expect(listConnections().some((c) => c.name === 'Bad')).toBe(false)
  })

  it('rejects sqlite input with no file path at all', async () => {
    const ctx = makeCtx(workspaceDir)
    const input = { name: 'Empty', engine: 'sqlite', filePath: '' }
    await expect(dbCreateConnectionTool.execute(input, ctx)).rejects.toThrow(/No sqlite file path given/)
  })

  it('falls back to finding the file in the workspace by basename when the given path is wrong (the model-guessed-relative-path case)', async () => {
    // Mirrors the real failure: the user gave an absolute path outside the
    // workspace, but the model passed a workspace-relative guess instead.
    // The real file actually sits in a workspace subfolder.
    const subdir = join(workspaceDir, 'data')
    await mkdir(subdir, { recursive: true })
    const realCopy = join(subdir, 'kagent_sample.db')
    const seed = new Database(realCopy)
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    seed.close()

    const ctx = makeCtx(workspaceDir)
    const input = { name: 'Found', engine: 'sqlite', filePath: 'data/kagent_sample.db' }
    await expect(dbCreateConnectionTool.validate?.(input, ctx)).resolves.toBeUndefined()

    const result = await dbCreateConnectionTool.execute(input, ctx)
    expect(result).toMatch(/Created and verified data connection "Found"/)
    const saved = listConnections().find((c) => c.name === 'Found')
    expect(saved?.filePath).toBe(realCopy)
  })

  it('rejects an ambiguous bare filename that matches more than one file in the workspace', async () => {
    const subdirA = join(workspaceDir, 'a')
    const subdirB = join(workspaceDir, 'b')
    await mkdir(subdirA, { recursive: true })
    await mkdir(subdirB, { recursive: true })
    for (const path of [join(subdirA, 'dup.db'), join(subdirB, 'dup.db')]) {
      const seed = new Database(path)
      seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      seed.close()
    }

    const ctx = makeCtx(workspaceDir)
    const input = { name: 'Ambiguous', engine: 'sqlite', filePath: 'dup.db' }
    await expect(dbCreateConnectionTool.execute(input, ctx)).rejects.toThrow(/more than one file/)
    expect(listConnections().some((c) => c.name === 'Ambiguous')).toBe(false)
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

describe('engine names', () => {
  it.each([
    ['SQL Server', 'mssql'],
    ['sql-server', 'mssql'],
    ['Microsoft SQL Server', 'mssql'],
    ['MSSQL', 'mssql'],
    ['PostgreSQL', 'postgres'],
    ['Postgres', 'postgres'],
    ['MariaDB', 'mysql'],
    ['MySQL', 'mysql'],
    ['SQLite3', 'sqlite'],
    ['sqlite', 'sqlite']
  ])('normalizes "%s" to %s', (raw, expected) => {
    expect(normalizeEngine(raw)).toBe(expected)
  })

  it('leaves an unrecognised engine as given, so the error can name it', async () => {
    expect(normalizeEngine('Oracle')).toBe('Oracle')
    await expect(dbCreateConnectionTool.execute({ name: 'X', engine: 'Oracle' }, {} as never)).rejects.toThrow(/Unknown engine "Oracle"/)
  })

  it('accepts the "SQL Server" label: gets past the engine check and fails only on the unreachable host', async () => {
    const input = { name: 'Label', engine: 'SQL Server', host: 'this-host-does-not-exist.invalid', port: 1433, database: 'db', username: 'sa', password: 'pw' }
    const err = await dbCreateConnectionTool.execute(input, {} as never).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/Unknown engine/)
    expect(listConnections().some((c) => c.name === 'Label')).toBe(false)
  }, 15000)

  it('shows the canonical engine in the confirmation text', () => {
    expect(dbCreateConnectionTool.describe?.({ name: 'N', engine: 'SQL Server', host: 'h', database: 'd' })).toBe('Create mssql connection "N" → h/d')
  })
})
