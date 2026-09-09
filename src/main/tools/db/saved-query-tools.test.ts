import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedQueryDto } from '@shared/ipc-contract'

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
const { buildSavedQueryTool, savedQueryToolName } = await import('./saved-query-tools')
const { WorkspaceGuard } = await import('../../security/workspace-guard')

const ctx = {
  workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-saved-query-tools-root')),
  currentSessionId: 'test-session'
}

describe('savedQueryToolName', () => {
  it('slugifies the query name and appends a stable id-derived suffix', () => {
    const query = { id: 'abc123-def456', name: 'Orders By Status!' } as SavedQueryDto
    expect(savedQueryToolName(query)).toBe('db_query_orders_by_status_abc123')
  })

  it('two queries with the same name get different tool names (id suffix differs)', () => {
    const a = { id: 'aaaaaa-1', name: 'Get Order' } as SavedQueryDto
    const b = { id: 'bbbbbb-2', name: 'Get Order' } as SavedQueryDto
    expect(savedQueryToolName(a)).not.toBe(savedQueryToolName(b))
  })
})

describe('buildSavedQueryTool', () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-saved-query-userdata-'))
    dir = await mkdtemp(join(tmpdir(), 'sachiv-saved-query-'))
    dbPath = join(dir, 'app.db')
    const seed = new Database(dbPath)
    seed.exec(`
      CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT NOT NULL, total REAL);
      INSERT INTO orders (status, total) VALUES ('paid', 10.5), ('paid', 20), ('pending', 5);
    `)
    seed.close()
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('builds an inputSchema with one property per declared param', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    const query: SavedQueryDto = {
      id: 'q1',
      connectionId: conn.id,
      name: 'orders_by_status',
      description: 'Orders with a given status',
      sql: 'SELECT * FROM orders WHERE status = :status',
      params: [{ name: 'status', type: 'string' }],
      mutates: false
    }
    const tool = buildSavedQueryTool(query)
    expect(tool.name).toBe(savedQueryToolName(query))
    expect(tool.inputSchema).toMatchObject({
      properties: { status: { type: 'string' } },
      required: ['status']
    })
    expect(tool.mutates).toBe(false)
  })

  it('executes the saved query with bound params, real results, no SQL written by the caller', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    const query: SavedQueryDto = {
      id: 'q1',
      connectionId: conn.id,
      name: 'orders_by_status',
      description: 'Orders with a given status',
      sql: 'SELECT * FROM orders WHERE status = :status',
      params: [{ name: 'status', type: 'string' }],
      mutates: false
    }
    const tool = buildSavedQueryTool(query)
    const result = await tool.execute({ status: 'paid' }, ctx)
    expect(result).toContain('2 row(s):')
    expect(result).toContain('10.5')
    expect(result).toContain('20')
    expect(result).not.toContain('pending')
  })

  it('the description names the actual connection, not its raw id', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: dbPath })
    const query: SavedQueryDto = {
      id: 'q1',
      connectionId: conn.id,
      name: 'q',
      description: 'desc',
      sql: 'SELECT 1',
      params: [],
      mutates: false
    }
    expect(buildSavedQueryTool(query).description).toContain('"Local"')
  })
})
