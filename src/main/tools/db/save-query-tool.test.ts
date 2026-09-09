import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedQueryDto } from '@shared/ipc-contract'
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
const { saveConnection, listSavedQueries } = await import('../../data/connections')
const { dbSaveQueryTool } = await import('./save-query-tool')
const { WorkspaceGuard } = await import('../../security/workspace-guard')

function makeCtx(): ToolContext & { registerSavedQuery: ReturnType<typeof vi.fn<(query: SavedQueryDto) => void>> } {
  return {
    workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-save-query-tool-root')),
    currentSessionId: 'test-session',
    registerSavedQuery: vi.fn<(query: SavedQueryDto) => void>()
  }
}

describe('db_save_query', () => {
  beforeEach(() => {
    setDbPath(':memory:')
    userDataDir = '/tmp/sachiv-save-query-tool-unused'
  })

  it('is always mutating (no per-input classification)', () => {
    expect(dbSaveQueryTool.mutates).toBe(true)
  })

  it('describe() shows the name, connection, and SQL for the confirmation dialog', () => {
    expect(
      dbSaveQueryTool.describe?.({ connection: 'Local', name: 'q1', sql: 'SELECT 1' })
    ).toBe('Save query "q1" on "Local": SELECT 1')
  })

  it('saves the query, persists it under the connection, and live-registers its tool via ctx', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const ctx = makeCtx()

    const result = await dbSaveQueryTool.execute(
      {
        connection: 'Local',
        name: 'orders_by_status',
        description: 'Orders with a given status',
        sql: 'SELECT * FROM orders WHERE status = :status',
        params: [{ name: 'status', type: 'string' }]
      },
      ctx
    )

    expect(result).toContain('db_query_orders_by_status_')
    expect(listSavedQueries(conn.id)).toHaveLength(1)
    expect(ctx.registerSavedQuery).toHaveBeenCalledTimes(1)
    expect(ctx.registerSavedQuery.mock.calls[0][0]).toMatchObject({ name: 'orders_by_status', connectionId: conn.id })
  })

  it('resolves the connection by name or by id', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const ctx = makeCtx()

    await dbSaveQueryTool.execute(
      { connection: conn.id, name: 'q1', description: '', sql: 'SELECT 1' },
      ctx
    )

    expect(listSavedQueries(conn.id)).toHaveLength(1)
  })

  it('rejects an unknown connection without saving anything', async () => {
    const ctx = makeCtx()
    await expect(
      dbSaveQueryTool.execute({ connection: 'nope', name: 'q1', description: '', sql: 'SELECT 1' }, ctx)
    ).rejects.toThrow(/Unknown data connection/)
    expect(ctx.registerSavedQuery).not.toHaveBeenCalled()
  })

  it('rejects a query whose SQL references an undeclared placeholder', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const ctx = makeCtx()
    await expect(
      dbSaveQueryTool.execute(
        { connection: conn.id, name: 'bad', description: '', sql: 'SELECT * FROM t WHERE x = :missing' },
        ctx
      )
    ).rejects.toThrow(/:missing/)
    expect(ctx.registerSavedQuery).not.toHaveBeenCalled()
  })

  it('rejects a param with an invalid type', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const ctx = makeCtx()
    await expect(
      dbSaveQueryTool.execute(
        {
          connection: conn.id,
          name: 'bad',
          description: '',
          sql: 'SELECT * FROM t WHERE x = :x',
          params: [{ name: 'x', type: 'date' }]
        },
        ctx
      )
    ).rejects.toThrow(/must be "string" or "number"/)
  })

  it('works with no ctx.registerSavedQuery (e.g. a bare test context)', async () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const bareCtx = { workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-bare')), currentSessionId: 's' }
    await expect(
      dbSaveQueryTool.execute({ connection: conn.id, name: 'q1', description: '', sql: 'SELECT 1' }, bareCtx)
    ).resolves.toContain('db_query_')
  })
})
