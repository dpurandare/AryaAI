import { beforeEach, describe, expect, it, vi } from 'vitest'

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
const { saveSavedQuery, deleteSavedQuery } = await import('../../data/saved-queries')
const { SavedQueryToolManager, savedQueryToolName } = await import('./saved-query-manager')
const { ToolRegistry } = await import('../registry')

describe('SavedQueryToolManager', () => {
  beforeEach(() => {
    setDbPath(':memory:')
    userDataDir = '/tmp/sachiv-saved-query-manager-unused'
  })

  it('register() adds a callable tool to the registry', () => {
    const registry = new ToolRegistry()
    const manager = new SavedQueryToolManager()
    const saved = saveSavedQuery({
      connectionId: 'conn-1',
      name: 'q1',
      description: 'd',
      sql: 'SELECT 1',
      params: []
    })

    manager.register(saved, registry)

    expect(registry.get(savedQueryToolName(saved))).toBeDefined()
  })

  it('syncAll() registers every existing saved query at once', () => {
    const registry = new ToolRegistry()
    const manager = new SavedQueryToolManager()
    saveSavedQuery({ connectionId: 'c', name: 'q1', description: '', sql: 'SELECT 1', params: [] })
    saveSavedQuery({ connectionId: 'c', name: 'q2', description: '', sql: 'SELECT 2', params: [] })

    manager.syncAll(registry)

    expect(registry.list()).toHaveLength(2)
  })

  it('unregister() removes the tool by tracked id, not by guessing a name', () => {
    const registry = new ToolRegistry()
    const manager = new SavedQueryToolManager()
    const saved = saveSavedQuery({ connectionId: 'c', name: 'q1', description: '', sql: 'SELECT 1', params: [] })
    manager.register(saved, registry)

    manager.unregister(saved.id, registry)

    expect(registry.list()).toHaveLength(0)
  })

  it('re-registering after an edit (rename) removes the old tool name, not just adds a new one', () => {
    const registry = new ToolRegistry()
    const manager = new SavedQueryToolManager()
    const saved = saveSavedQuery({ connectionId: 'c', name: 'original_name', description: '', sql: 'SELECT 1', params: [] })
    manager.register(saved, registry)
    const oldToolName = savedQueryToolName(saved)

    const renamed = saveSavedQuery({ id: saved.id, connectionId: 'c', name: 'new_name', description: '', sql: 'SELECT 1', params: [] })
    manager.register(renamed, registry)

    expect(registry.get(oldToolName)).toBeUndefined()
    expect(registry.list()).toHaveLength(1)
    expect(registry.get(savedQueryToolName(renamed))).toBeDefined()
  })

  it('unregister() is a safe no-op for an id that was never registered', () => {
    const registry = new ToolRegistry()
    const manager = new SavedQueryToolManager()
    expect(() => manager.unregister('never-registered', registry)).not.toThrow()
  })

  it('deleting the underlying saved query does not remove its tool by itself — the caller must also call unregister', () => {
    // Documents the actual contract (register.ts's SavedQueriesDelete handler does both) rather than
    // asserting behavior the manager doesn't own — deleteSavedQuery() only touches the data layer.
    const registry = new ToolRegistry()
    const manager = new SavedQueryToolManager()
    const saved = saveSavedQuery({ connectionId: 'c', name: 'q1', description: '', sql: 'SELECT 1', params: [] })
    manager.register(saved, registry)

    deleteSavedQuery(saved.id)

    expect(registry.list()).toHaveLength(1)
  })
})
