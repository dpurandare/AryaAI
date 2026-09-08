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
const { listConnections, saveConnection, deleteConnection, resolveConnection } = await import('./connections')
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
})
