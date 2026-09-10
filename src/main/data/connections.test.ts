import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// data/connections.ts -> security/keychain.ts imports `electron` (app,
// safeStorage) at module scope, which crashes outside a real Electron
// process (see db/index.ts's setDbPath comment for the same hazard class).
// Mock it here rather than importing keychain.ts's real dependency.
let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // Reversible fake, not real security — fine for a test double.
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const { setDbPath } = await import('../db')
const {
  listConnections,
  saveConnection,
  deleteConnection,
  resolveConnection,
  listSavedQueries,
  saveSavedQuery,
  deleteSavedQuery,
  getConnection,
  updateConnectionSchemaSummary
} = await import('./connections')
const { getApiKey } = await import('../security/keychain')

describe('data connections', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-connections-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('starts with no connections', () => {
    expect(listConnections()).toEqual([])
  })

  it('saves and lists a sqlite connection (no password involved)', () => {
    const saved = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    expect(listConnections()).toEqual([saved])
    expect(saved).toMatchObject({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
  })

  it('saves a postgres connection with the password kept out of the metadata list', () => {
    const saved = saveConnection({
      name: 'Prod',
      engine: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      username: 'app_user',
      password: 'super-secret'
    })
    const listed = listConnections()
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('password')
    expect(saved).not.toHaveProperty('password')
  })

  it('resolves a saved postgres connection, including the password from the keychain', () => {
    saveConnection({
      name: 'Prod',
      engine: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      username: 'app_user',
      password: 'super-secret'
    })
    const resolved = resolveConnection('Prod')
    expect(resolved).toEqual({
      engine: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      username: 'app_user',
      password: 'super-secret'
    })
  })

  it('resolves by id as well as by name', () => {
    const saved = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    expect(resolveConnection(saved.id)).toEqual({ engine: 'sqlite', filePath: '/data/app.db' })
  })

  it('returns undefined for an unknown connection', () => {
    expect(resolveConnection('nope')).toBeUndefined()
  })

  it('editing a connection without a new password keeps the old one', () => {
    const saved = saveConnection({
      name: 'Prod',
      engine: 'postgres',
      host: 'old-host',
      port: 5432,
      database: 'app',
      username: 'app_user',
      password: 'original-secret'
    })
    saveConnection({ id: saved.id, name: 'Prod', engine: 'postgres', host: 'new-host', port: 5432, database: 'app', username: 'app_user' })

    const resolved = resolveConnection(saved.id)
    expect(resolved).toMatchObject({ host: 'new-host', password: 'original-secret' })
  })

  it('deleting a connection also removes its keychain password, not just the metadata', () => {
    const saved = saveConnection({
      name: 'Prod',
      engine: 'postgres',
      host: 'h',
      port: 5432,
      database: 'd',
      username: 'u',
      password: 'secret'
    })
    expect(getApiKey(`db:${saved.id}`)).toBe('secret')

    deleteConnection(saved.id)

    expect(listConnections()).toEqual([])
    expect(getApiKey(`db:${saved.id}`)).toBeUndefined()
  })

  it('a new connection starts with an empty savedQueries array', () => {
    const saved = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    expect(saved.savedQueries).toEqual([])
  })

  it('editing a connection preserves its saved queries — a plain replace would otherwise wipe them', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const query = saveSavedQuery({
      connectionId: conn.id,
      name: 'q1',
      description: '',
      sql: 'SELECT 1',
      params: []
    })

    saveConnection({ id: conn.id, name: 'Local (renamed)', engine: 'sqlite', filePath: '/data/app2.db' })

    expect(listSavedQueries(conn.id)).toEqual([query])
  })

  it('deleting a connection removes its saved queries too, with no separate cascade call needed', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    saveSavedQuery({ connectionId: conn.id, name: 'q1', description: '', sql: 'SELECT 1', params: [] })

    deleteConnection(conn.id)

    expect(listSavedQueries()).toEqual([])
  })

  it('saveSavedQuery computes mutates from the SQL text', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const read = saveSavedQuery({ connectionId: conn.id, name: 'r', description: '', sql: 'SELECT 1', params: [] })
    const write = saveSavedQuery({
      connectionId: conn.id,
      name: 'w',
      description: '',
      sql: 'UPDATE t SET x = 1',
      params: []
    })
    expect(read.mutates).toBe(false)
    expect(write.mutates).toBe(true)
  })

  it('saveSavedQuery rejects a query whose SQL references an undeclared placeholder', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    expect(() =>
      saveSavedQuery({
        connectionId: conn.id,
        name: 'bad',
        description: '',
        sql: 'SELECT * FROM t WHERE status = :status',
        params: []
      })
    ).toThrow(/:status/)
  })

  it('saveSavedQuery rejects an unknown connection', () => {
    expect(() =>
      saveSavedQuery({ connectionId: 'nope', name: 'q', description: '', sql: 'SELECT 1', params: [] })
    ).toThrow(/Unknown data connection/)
  })

  it('listSavedQueries scopes by connection, or lists all with no argument', () => {
    const a = saveConnection({ name: 'A', engine: 'sqlite', filePath: '/a.db' })
    const b = saveConnection({ name: 'B', engine: 'sqlite', filePath: '/b.db' })
    saveSavedQuery({ connectionId: a.id, name: 'qa', description: '', sql: 'SELECT 1', params: [] })
    saveSavedQuery({ connectionId: b.id, name: 'qb', description: '', sql: 'SELECT 1', params: [] })

    expect(listSavedQueries(a.id).map((q) => q.name)).toEqual(['qa'])
    expect(listSavedQueries().map((q) => q.name).sort()).toEqual(['qa', 'qb'])
  })

  it('deleteSavedQuery removes one query without touching others on the same connection', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const q1 = saveSavedQuery({ connectionId: conn.id, name: 'q1', description: '', sql: 'SELECT 1', params: [] })
    saveSavedQuery({ connectionId: conn.id, name: 'q2', description: '', sql: 'SELECT 2', params: [] })

    deleteSavedQuery(q1.id)

    expect(listSavedQueries(conn.id).map((q) => q.name)).toEqual(['q2'])
  })

  it('getConnection finds by id, or undefined if unknown', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    expect(getConnection(conn.id)).toEqual(conn)
    expect(getConnection('nope')).toBeUndefined()
  })

  it('updateConnectionSchemaSummary sets the summary without touching the rest of the connection', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const summary = { tables: ['users', 'orders'], truncated: false, updatedAt: 123 }

    updateConnectionSchemaSummary(conn.id, summary)

    expect(getConnection(conn.id)).toMatchObject({ name: 'Local', schemaSummary: summary })
  })

  it('updateConnectionSchemaSummary is a safe no-op for an unknown connection', () => {
    expect(() =>
      updateConnectionSchemaSummary('nope', { tables: [], truncated: false, updatedAt: 0 })
    ).not.toThrow()
  })

  it('editing a connection preserves its cached schema summary, the same way it preserves saved queries', () => {
    const conn = saveConnection({ name: 'Local', engine: 'sqlite', filePath: '/data/app.db' })
    const summary = { tables: ['users'], truncated: false, updatedAt: 1 }
    updateConnectionSchemaSummary(conn.id, summary)

    saveConnection({ id: conn.id, name: 'Local (renamed)', engine: 'sqlite', filePath: '/data/app.db' })

    expect(getConnection(conn.id)?.schemaSummary).toEqual(summary)
  })
})
