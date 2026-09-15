import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same electron-at-module-scope hazard as data/connections.test.ts — see
// that file's comment for the full reasoning.
let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const { setDbPath } = await import('../db')
const {
  listApiConnections,
  saveApiConnection,
  deleteApiConnection,
  resolveApiConnection,
  getApiConnection,
  updateApiConnectionSpecSummary
} = await import('./api-connections')
const { getApiKey } = await import('../security/keychain')

describe('api connections', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-api-connections-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('starts with no connections', () => {
    expect(listApiConnections()).toEqual([])
  })

  it('saves a no-auth connection with no secret involved', () => {
    const saved = saveApiConnection({ name: 'Public', baseUrl: 'https://api.example.com', authType: 'none' })
    expect(listApiConnections()).toEqual([saved])
    expect(saved).toMatchObject({ name: 'Public', baseUrl: 'https://api.example.com', authType: 'none', hasSecret: false })
  })

  it('strips trailing slashes from the base URL', () => {
    const saved = saveApiConnection({ name: 'X', baseUrl: 'https://api.example.com/v1///', authType: 'none' })
    expect(saved.baseUrl).toBe('https://api.example.com/v1')
  })

  it('saves an apiKey connection with the secret kept out of the metadata list, defaulting the header name', () => {
    const saved = saveApiConnection({
      name: 'Keyed',
      baseUrl: 'https://api.example.com',
      authType: 'apiKey',
      secret: 'shh'
    })
    expect(saved.apiKeyHeader).toBe('X-API-Key')
    expect(saved.hasSecret).toBe(true)
    expect(saved).not.toHaveProperty('secret')
    expect(listApiConnections()[0]).not.toHaveProperty('secret')
  })

  it('respects a custom apiKey header name', () => {
    const saved = saveApiConnection({
      name: 'Keyed',
      baseUrl: 'https://api.example.com',
      authType: 'apiKey',
      apiKeyHeader: 'X-Custom-Key',
      secret: 'shh'
    })
    expect(saved.apiKeyHeader).toBe('X-Custom-Key')
  })

  it('resolves a saved connection, including the secret from the keychain', () => {
    saveApiConnection({ name: 'Bearer', baseUrl: 'https://api.example.com', authType: 'bearer', secret: 'token123' })
    const resolved = resolveApiConnection('Bearer')
    expect(resolved).toMatchObject({ baseUrl: 'https://api.example.com', authType: 'bearer', secret: 'token123' })
  })

  it('resolves by id as well as by name', () => {
    const saved = saveApiConnection({ name: 'X', baseUrl: 'https://api.example.com', authType: 'none' })
    expect(resolveApiConnection(saved.id)?.baseUrl).toBe('https://api.example.com')
  })

  it('returns undefined for an unknown connection', () => {
    expect(resolveApiConnection('nope')).toBeUndefined()
  })

  it('editing a connection without a new secret keeps the old one', () => {
    const saved = saveApiConnection({
      name: 'Bearer',
      baseUrl: 'https://old.example.com',
      authType: 'bearer',
      secret: 'original-token'
    })
    saveApiConnection({ id: saved.id, name: 'Bearer', baseUrl: 'https://new.example.com', authType: 'bearer' })

    const resolved = resolveApiConnection(saved.id)
    expect(resolved).toMatchObject({ baseUrl: 'https://new.example.com', secret: 'original-token' })
  })

  it('deleting a connection also removes its keychain secret, not just the metadata', () => {
    const saved = saveApiConnection({ name: 'Bearer', baseUrl: 'https://api.example.com', authType: 'bearer', secret: 'token' })
    expect(getApiKey(`api:${saved.id}`)).toBe('token')

    deleteApiConnection(saved.id)

    expect(listApiConnections()).toEqual([])
    expect(getApiKey(`api:${saved.id}`)).toBeUndefined()
  })

  it('getApiConnection finds by id, or undefined if unknown', () => {
    const conn = saveApiConnection({ name: 'X', baseUrl: 'https://api.example.com', authType: 'none' })
    expect(getApiConnection(conn.id)).toEqual(conn)
    expect(getApiConnection('nope')).toBeUndefined()
  })

  it('updateApiConnectionSpecSummary sets the summary without touching the rest of the connection', () => {
    const conn = saveApiConnection({ name: 'X', baseUrl: 'https://api.example.com', authType: 'none' })
    const summary = { endpointCount: 3, sample: ['GET /users'], updatedAt: 123 }

    updateApiConnectionSpecSummary(conn.id, summary)

    expect(getApiConnection(conn.id)).toMatchObject({ name: 'X', specSummary: summary })
  })

  it('updateApiConnectionSpecSummary is a safe no-op for an unknown connection', () => {
    expect(() => updateApiConnectionSpecSummary('nope', { endpointCount: 0, sample: [], updatedAt: 0 })).not.toThrow()
  })

  it('editing a connection preserves its cached spec summary', () => {
    const conn = saveApiConnection({ name: 'X', baseUrl: 'https://api.example.com', authType: 'none' })
    const summary = { endpointCount: 1, sample: ['GET /x'], updatedAt: 1 }
    updateApiConnectionSpecSummary(conn.id, summary)

    saveApiConnection({ id: conn.id, name: 'X (renamed)', baseUrl: 'https://api.example.com', authType: 'none' })

    expect(getApiConnection(conn.id)?.specSummary).toEqual(summary)
  })
})
