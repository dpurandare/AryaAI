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
  listEmailConnections,
  saveEmailConnection,
  deleteEmailConnection,
  resolveEmailConnection,
  resolveDefaultEmailConnection,
  getDefaultEmailConnectionId,
  setDefaultEmailConnection
} = await import('./email-connections')
const { getApiKey } = await import('../security/keychain')
const { setSetting } = await import('../db/settings')

describe('email connections (#79)', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-email-conn-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('saves a connection with the app password kept out of the metadata list', () => {
    const saved = saveEmailConnection({
      name: 'Work Gmail',
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      appPassword: 'abcd efgh ijkl mnop'
    })
    expect(listEmailConnections()).toEqual([saved])
    expect(saved).toMatchObject({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', hasSecret: true })
    expect(saved).not.toHaveProperty('appPassword')
  })

  it('saves a custom SMTP connection with its own host/port/secure, kept alongside Gmail connections', () => {
    const saved = saveEmailConnection({
      name: 'Company mail server',
      provider: 'custom',
      emailAddress: 'me@company.com',
      appPassword: 'a-password',
      host: 'smtp.company.com',
      port: 465,
      secure: true
    })
    expect(saved).toMatchObject({
      provider: 'custom',
      emailAddress: 'me@company.com',
      host: 'smtp.company.com',
      port: 465,
      secure: true
    })
    expect(resolveEmailConnection(saved.id)).toMatchObject({
      provider: 'custom',
      host: 'smtp.company.com',
      port: 465,
      secure: true,
      appPassword: 'a-password'
    })
  })

  it('editing a custom SMTP connection without re-specifying host/port/secure keeps the old ones', () => {
    const saved = saveEmailConnection({
      name: 'Company mail server',
      provider: 'custom',
      emailAddress: 'me@company.com',
      appPassword: 'a-password',
      host: 'smtp.company.com',
      port: 465,
      secure: true
    })
    saveEmailConnection({ id: saved.id, name: 'Renamed', provider: 'custom', emailAddress: 'me@company.com' })
    expect(resolveEmailConnection(saved.id)).toMatchObject({ host: 'smtp.company.com', port: 465, secure: true })
  })

  it('resolves a saved connection, including the app password from the keychain', () => {
    saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'secret-pw' })
    expect(resolveEmailConnection('Work Gmail')).toEqual({
      id: expect.any(String),
      name: 'Work Gmail',
      emailAddress: 'me@gmail.com',
      provider: 'gmail',
      appPassword: 'secret-pw'
    })
  })

  it('resolves by id as well as by name', () => {
    const saved = saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
    expect(resolveEmailConnection(saved.id)?.emailAddress).toBe('me@gmail.com')
  })

  it('returns undefined for an unknown connection', () => {
    expect(resolveEmailConnection('nope')).toBeUndefined()
  })

  it('editing a connection without a new app password keeps the old one', () => {
    const saved = saveEmailConnection({
      name: 'Work Gmail',
      provider: 'gmail',
      emailAddress: 'old@gmail.com',
      appPassword: 'original'
    })
    saveEmailConnection({ id: saved.id, name: 'Work Gmail', provider: 'gmail', emailAddress: 'new@gmail.com' })
    expect(resolveEmailConnection(saved.id)).toMatchObject({ emailAddress: 'new@gmail.com', appPassword: 'original' })
  })

  it('editing a connection without re-specifying the provider keeps the old one, not the default', () => {
    const saved = saveEmailConnection({
      name: 'Company mail',
      provider: 'custom',
      emailAddress: 'me@company.com',
      appPassword: 'pw',
      host: 'smtp.company.com',
      port: 587
    })
    saveEmailConnection({ id: saved.id, name: 'Company mail (renamed)', provider: 'custom', emailAddress: 'me@company.com' })
    expect(resolveEmailConnection(saved.id)).toMatchObject({ provider: 'custom' })
  })

  it('deleting a connection also removes its keychain app password, not just the metadata', () => {
    const saved = saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
    expect(getApiKey(`email:${saved.id}`)).toBe('pw')
    deleteEmailConnection(saved.id)
    expect(listEmailConnections()).toEqual([])
    expect(getApiKey(`email:${saved.id}`)).toBeUndefined()
  })

  it('reads a connection saved before the `provider` field existed (no provider field at all) back as Gmail', () => {
    // Simulates an already-saved settings row from before the `provider`
    // field existed — must not break/misclassify an existing working
    // account. saveEmailConnection always writes the field now, so this
    // writes the settings row directly, the way a real pre-existing row
    // would look, to exercise resolveEmailConnection's own defensive
    // fallback for whatever is already on disk from before this shipped.
    const saved = saveEmailConnection({ name: 'Legacy', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
    const { provider: _provider, ...withoutProvider } = listEmailConnections()[0]
    setSetting('emailConnections', JSON.stringify([withoutProvider]))
    expect(resolveEmailConnection(saved.id)).toMatchObject({ provider: 'gmail' })
  })

  describe('default account', () => {
    it('the sole configured connection is automatically the default, with no explicit "set default" step', () => {
      const saved = saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'me@gmail.com', appPassword: 'pw' })
      expect(saved.isDefault).toBe(true)
      expect(listEmailConnections()[0].isDefault).toBe(true)
      expect(getDefaultEmailConnectionId()).toBe(saved.id)
      expect(resolveDefaultEmailConnection()).toMatchObject({ id: saved.id, emailAddress: 'me@gmail.com' })
    })

    it('a second account is not automatically default — ambiguous on purpose until the user picks one', () => {
      const first = saveEmailConnection({ name: 'Work Gmail', provider: 'gmail', emailAddress: 'a@gmail.com', appPassword: 'pw' })
      const second = saveEmailConnection({ name: 'Company mail', provider: 'custom', emailAddress: 'b@company.com', host: 'smtp.company.com', appPassword: 'pw' })
      expect(first.isDefault).toBe(true) // it was the sole account at the moment it was saved
      expect(second.isDefault).toBe(false)
      // But *listing* afterward reflects the real current state, same rule.
      const list = listEmailConnections()
      expect(list.find((c) => c.id === first.id)?.isDefault).toBe(false)
      expect(list.find((c) => c.id === second.id)?.isDefault).toBe(false)
      expect(getDefaultEmailConnectionId()).toBeUndefined()
      expect(resolveDefaultEmailConnection()).toBeUndefined()
    })

    it('setDefaultEmailConnection makes an explicit choice among multiple accounts', () => {
      const first = saveEmailConnection({ name: 'A', provider: 'gmail', emailAddress: 'a@gmail.com', appPassword: 'pw' })
      const second = saveEmailConnection({ name: 'B', provider: 'custom', emailAddress: 'b@company.com', host: 'smtp.company.com', appPassword: 'pw' })
      setDefaultEmailConnection(second.id)
      expect(getDefaultEmailConnectionId()).toBe(second.id)
      const list = listEmailConnections()
      expect(list.find((c) => c.id === first.id)?.isDefault).toBe(false)
      expect(list.find((c) => c.id === second.id)?.isDefault).toBe(true)
      expect(resolveDefaultEmailConnection()).toMatchObject({ id: second.id })
    })

    it('setDefaultEmailConnection rejects an unknown id', () => {
      expect(() => setDefaultEmailConnection('nope')).toThrow(/Unknown email connection "nope"/)
    })

    it('deleting the explicit default falls back to the sole remaining account, not to "no default"', () => {
      const first = saveEmailConnection({ name: 'A', provider: 'gmail', emailAddress: 'a@gmail.com', appPassword: 'pw' })
      const second = saveEmailConnection({ name: 'B', provider: 'custom', emailAddress: 'b@company.com', host: 'smtp.company.com', appPassword: 'pw' })
      setDefaultEmailConnection(second.id)
      deleteEmailConnection(second.id)
      // Only `first` is left — the sole-account fallback rule picks it back
      // up automatically, even though it was never explicitly chosen.
      expect(getDefaultEmailConnectionId()).toBe(first.id)
    })

    it('deleting a non-default account among 3+ leaves the explicit default untouched', () => {
      const a = saveEmailConnection({ name: 'A', provider: 'gmail', emailAddress: 'a@gmail.com', appPassword: 'pw' })
      const b = saveEmailConnection({ name: 'B', provider: 'gmail', emailAddress: 'b@gmail.com', appPassword: 'pw' })
      const c = saveEmailConnection({ name: 'C', provider: 'custom', emailAddress: 'c@company.com', host: 'smtp.company.com', appPassword: 'pw' })
      setDefaultEmailConnection(b.id)
      deleteEmailConnection(a.id)
      expect(getDefaultEmailConnectionId()).toBe(b.id)
      expect(listEmailConnections().map((conn) => conn.id).sort()).toEqual([b.id, c.id].sort())
    })
  })
})
