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
const { listEmailConnections, saveEmailConnection, deleteEmailConnection, resolveEmailConnection } = await import(
  './email-connections'
)
const { getApiKey } = await import('../security/keychain')

describe('email connections (#79)', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-email-conn-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('saves a connection with the app password kept out of the metadata list', () => {
    const saved = saveEmailConnection({ name: 'Work Gmail', emailAddress: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' })
    expect(listEmailConnections()).toEqual([saved])
    expect(saved).toMatchObject({ name: 'Work Gmail', emailAddress: 'me@gmail.com', hasSecret: true })
    expect(saved).not.toHaveProperty('appPassword')
  })

  it('resolves a saved connection, including the app password from the keychain', () => {
    saveEmailConnection({ name: 'Work Gmail', emailAddress: 'me@gmail.com', appPassword: 'secret-pw' })
    expect(resolveEmailConnection('Work Gmail')).toEqual({
      id: expect.any(String),
      name: 'Work Gmail',
      emailAddress: 'me@gmail.com',
      appPassword: 'secret-pw'
    })
  })

  it('resolves by id as well as by name', () => {
    const saved = saveEmailConnection({ name: 'Work Gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
    expect(resolveEmailConnection(saved.id)?.emailAddress).toBe('me@gmail.com')
  })

  it('returns undefined for an unknown connection', () => {
    expect(resolveEmailConnection('nope')).toBeUndefined()
  })

  it('editing a connection without a new app password keeps the old one', () => {
    const saved = saveEmailConnection({ name: 'Work Gmail', emailAddress: 'old@gmail.com', appPassword: 'original' })
    saveEmailConnection({ id: saved.id, name: 'Work Gmail', emailAddress: 'new@gmail.com' })
    expect(resolveEmailConnection(saved.id)).toMatchObject({ emailAddress: 'new@gmail.com', appPassword: 'original' })
  })

  it('deleting a connection also removes its keychain app password, not just the metadata', () => {
    const saved = saveEmailConnection({ name: 'Work Gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
    expect(getApiKey(`email:${saved.id}`)).toBe('pw')
    deleteEmailConnection(saved.id)
    expect(listEmailConnections()).toEqual([])
    expect(getApiKey(`email:${saved.id}`)).toBeUndefined()
  })
})
