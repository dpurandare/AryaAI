import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { listApiConnections } = await import('../../data/api-connections')
const { apiCreateConnectionTool } = await import('./api')

describe('api_create_connection', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-api-create-conn-'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('always mutates, declares the 3 possible secret fields, and describes the target', () => {
    expect(apiCreateConnectionTool.mutates).toBe(true)
    expect(apiCreateConnectionTool.secretFields).toEqual(['apiKey', 'token', 'password'])
    expect(apiCreateConnectionTool.describe?.({ name: 'X', baseUrl: 'https://api.example.com', authType: 'bearer' })).toBe(
      'Create API connection "X" → https://api.example.com (bearer)'
    )
  })

  it('validates and creates a connection when the probe succeeds', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })))
    const input = { name: 'Good', baseUrl: 'https://api.example.com', authType: 'bearer', token: 'shh' }

    await expect(apiCreateConnectionTool.validate?.(input, {} as never)).resolves.toBeUndefined()

    const result = await apiCreateConnectionTool.execute(input, {} as never)
    expect(result).toMatch(/Created and verified API connection "Good"/)
    const saved = listApiConnections().find((c) => c.name === 'Good')
    expect(saved?.authType).toBe('bearer')
    expect(saved?.hasSecret).toBe(true)
  })

  it('rejects a 401, and does not persist anything', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response('nope', { status: 401, statusText: 'Unauthorized' })))
    const input = { name: 'Bad', baseUrl: 'https://api.example.com', authType: 'bearer', token: 'wrong' }

    await expect(apiCreateConnectionTool.validate?.(input, {} as never)).rejects.toThrow(/401/)
    await expect(apiCreateConnectionTool.execute(input, {} as never)).rejects.toThrow(/401/)
    expect(listApiConnections().some((c) => c.name === 'Bad')).toBe(false)
  })

  it('rejects a real network failure, and does not persist anything', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.reject(new Error('fetch failed')))
    const input = { name: 'Unreachable', baseUrl: 'https://does-not-exist.example', authType: 'none' }

    await expect(apiCreateConnectionTool.execute(input, {} as never)).rejects.toThrow()
    expect(listApiConnections().some((c) => c.name === 'Unreachable')).toBe(false)
  })

  it('a 404 does not fail validation — only 401/403 do', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response('not found', { status: 404 })))
    const input = { name: 'NoRoot', baseUrl: 'https://api.example.com', authType: 'none' }
    await expect(apiCreateConnectionTool.validate?.(input, {} as never)).resolves.toBeUndefined()
  })
})
