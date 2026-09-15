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
const { saveApiConnection, getApiConnection } = await import('../../data/api-connections')
const { apiIntrospectTool } = await import('./introspect')

const SPEC = {
  openapi: '3.0.0',
  paths: {
    '/users': {
      get: { summary: 'List users', parameters: [{ name: 'limit' }] },
      post: { summary: 'Create a user', requestBody: {} }
    },
    '/users/{id}': {
      get: { summary: 'Get a user', parameters: [{ name: 'id' }] }
    }
  }
}

describe('api_introspect', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-api-introspect-'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('is never mutating', () => {
    expect(apiIntrospectTool.mutates).toBe(false)
  })

  it('returns a friendly message for an unknown connection', async () => {
    const result = await apiIntrospectTool.execute({ connection: 'nope' }, {} as never)
    expect(result).toMatch(/No API connection named "nope"/)
  })

  it('fetches the configured specUrl directly, without probing well-known paths', async () => {
    const conn = saveApiConnection({
      name: 'X',
      baseUrl: 'https://api.example.com',
      authType: 'none',
      specUrl: 'https://api.example.com/my-spec.json'
    })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(SPEC), { status: 200 }))

    const result = await apiIntrospectTool.execute({ connection: conn.name }, {} as never)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.example.com/my-spec.json')
    expect(result).toContain('GET /users — List users [limit]')
    expect(result).toContain('POST /users — Create a user [(request body)]')
    expect(result).toContain('GET /users/{id} — Get a user [id]')
  })

  it('probes well-known paths in order and stops at the first that has a real spec', async () => {
    const conn = saveApiConnection({ name: 'Y', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(SPEC), { status: 200 }))

    const result = await apiIntrospectTool.execute({ connection: conn.name }, {} as never)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.example.com/openapi.json')
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://api.example.com/swagger.json')
    expect(result).toContain('3 endpoints')
  })

  it('caches a spec summary onto the connection once a spec is found', async () => {
    const conn = saveApiConnection({ name: 'Z', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(SPEC), { status: 200 }))

    await apiIntrospectTool.execute({ connection: conn.name }, {} as never)

    const updated = getApiConnection(conn.id)
    expect(updated?.specSummary?.endpointCount).toBe(3)
    expect(updated?.specSummary?.sample).toContain('GET /users')
  })

  it('reports plainly when no spec can be found anywhere', async () => {
    const conn = saveApiConnection({ name: 'W', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }))

    const result = await apiIntrospectTool.execute({ connection: conn.name }, {} as never)

    expect(fetch).toHaveBeenCalledTimes(5) // all well-known paths tried
    expect(result).toMatch(/No OpenAPI\/Swagger spec found/)
  })
})
