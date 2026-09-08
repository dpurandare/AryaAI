import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// mcp/config.ts -> security/keychain.ts imports `electron` at module scope,
// which crashes outside a real Electron process — same hazard documented in
// data/connections.test.ts. Mock it here rather than importing the real one.
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
const { listServerConfigs, saveServerConfig, deleteServerConfig, getServerToken } = await import('./config')
const { getApiKey } = await import('../security/keychain')

describe('mcp server config', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-mcp-config-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('starts with no servers', () => {
    expect(listServerConfigs()).toEqual([])
  })

  it('saves and lists a stdio server', () => {
    const saved = saveServerConfig({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'x'] })
    expect(listServerConfigs()).toEqual([saved])
    expect(saved).toMatchObject({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'x'] })
  })

  it('saves an http server with the token kept out of the metadata list', () => {
    const saved = saveServerConfig({ name: 'remote', transport: 'http', url: 'https://x.test', token: 'secret' })
    const listed = listServerConfigs()
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('token')
    expect(listed[0].hasToken).toBe(true)
    expect(getServerToken(saved.id)).toBe('secret')
  })

  it('rejects a duplicate server name', () => {
    saveServerConfig({ name: 'dup', transport: 'stdio', command: 'echo' })
    expect(() => saveServerConfig({ name: 'dup', transport: 'stdio', command: 'echo' })).toThrow(/already exists/)
  })

  it('allows renaming a server to its own current name (no false collision)', () => {
    const saved = saveServerConfig({ name: 'same', transport: 'stdio', command: 'echo' })
    expect(() => saveServerConfig({ id: saved.id, name: 'same', transport: 'stdio', command: 'echo2' })).not.toThrow()
  })

  it('editing a server without a new token keeps the old one and hasToken true', () => {
    const saved = saveServerConfig({ name: 'remote', transport: 'http', url: 'https://x.test', token: 'original' })
    const edited = saveServerConfig({ id: saved.id, name: 'remote', transport: 'http', url: 'https://y.test' })
    expect(edited.hasToken).toBe(true)
    expect(getServerToken(saved.id)).toBe('original')
  })

  it('deleting a server also removes its keychain token, not just the metadata', () => {
    const saved = saveServerConfig({ name: 'remote', transport: 'http', url: 'https://x.test', token: 'secret' })
    expect(getApiKey(`mcp:${saved.id}`)).toBe('secret')

    deleteServerConfig(saved.id)

    expect(listServerConfigs()).toEqual([])
    expect(getApiKey(`mcp:${saved.id}`)).toBeUndefined()
  })
})
