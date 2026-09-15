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
const { saveApiConnection } = await import('../../data/api-connections')
const { apiCallTool } = await import('./call')

describe('api_call', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-api-call-'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('mutates is false for GET/HEAD/OPTIONS and true for anything else', () => {
    const mutates = apiCallTool.mutates as (input: Record<string, unknown>) => boolean
    expect(mutates({ method: 'GET' })).toBe(false)
    expect(mutates({})).toBe(false) // defaults to GET
    expect(mutates({ method: 'head' })).toBe(false)
    expect(mutates({ method: 'POST' })).toBe(true)
    expect(mutates({ method: 'delete' })).toBe(true)
  })

  it('returns a friendly message for an unknown connection instead of throwing', async () => {
    const result = await apiCallTool.execute({ connection: 'nope', path: '/x' }, {} as never)
    expect(result).toMatch(/No API connection named "nope"/)
  })

  it('applies an apiKey header from the connection', async () => {
    const conn = saveApiConnection({
      name: 'Keyed',
      baseUrl: 'https://api.example.com',
      authType: 'apiKey',
      apiKeyHeader: 'X-Custom-Key',
      secret: 'shh'
    })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await apiCallTool.execute({ connection: conn.name, path: '/ping' }, {} as never)

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect((init?.headers as Record<string, string>)['X-Custom-Key']).toBe('shh')
  })

  it('applies a bearer Authorization header', async () => {
    const conn = saveApiConnection({ name: 'B', baseUrl: 'https://api.example.com', authType: 'bearer', secret: 'token123' })
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))

    await apiCallTool.execute({ connection: conn.name, path: '/x' }, {} as never)

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token123')
  })

  it('applies a basic Authorization header from username + secret', async () => {
    const conn = saveApiConnection({
      name: 'C',
      baseUrl: 'https://api.example.com',
      authType: 'basic',
      username: 'alice',
      secret: 'wonderland'
    })
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))

    await apiCallTool.execute({ connection: conn.name, path: '/x' }, {} as never)

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const expected = `Basic ${Buffer.from('alice:wonderland').toString('base64')}`
    expect((init?.headers as Record<string, string>).Authorization).toBe(expected)
  })

  it('resolves a relative path against the base URL without clobbering a base sub-path', async () => {
    const conn = saveApiConnection({ name: 'D', baseUrl: 'https://api.example.com/v1', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))

    await apiCallTool.execute({ connection: conn.name, path: '/users' }, {} as never)

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/users')
  })

  it('sends an object body as JSON with a Content-Type header', async () => {
    const conn = saveApiConnection({ name: 'E', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 201 }))

    await apiCallTool.execute({ connection: conn.name, method: 'POST', path: '/x', body: { a: 1 } }, {} as never)

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(init?.body).toBe(JSON.stringify({ a: 1 }))
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('detects a 202 Accepted response as an async job and points at api_check_status', async () => {
    const conn = saveApiConnection({ name: 'F', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(
      new Response('{}', { status: 202, headers: { Location: 'https://api.example.com/jobs/1' } })
    )

    const result = await apiCallTool.execute({ connection: conn.name, method: 'POST', path: '/x' }, {} as never)

    expect(result).toMatch(/202 Accepted/)
    expect(result).toMatch(/api_check_status/)
    expect(result).toContain('statusUrl="https://api.example.com/jobs/1"')
  })

  it('detects a pending job-style body as an async job', async () => {
    const conn = saveApiConnection({ name: 'G', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'job-1', status: 'running' }), { status: 200 })
    )

    const result = await apiCallTool.execute({ connection: conn.name, path: '/x' }, {} as never)

    expect(result).toMatch(/asynchronous job still in progress/)
    expect(result).toMatch(/api_check_status/)
  })

  it('follows Link-header pagination and concatenates array items across pages', async () => {
    const conn = saveApiConnection({ name: 'H', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
          status: 200,
          headers: { Link: '<https://api.example.com/x?page=2>; rel="next"' }
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 3 }]), { status: 200 }))

    const result = await apiCallTool.execute({ connection: conn.name, path: '/x', paginate: true }, {} as never)

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://api.example.com/x?page=2')
    expect(result).toContain('2 page(s), 3 item(s) total')
    expect(result).toContain('"id": 3')
  })

  it('stops paginating once maxPages is reached even if a next link remains', async () => {
    const conn = saveApiConnection({ name: 'I', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: { Link: '<https://api.example.com/x?page=9>; rel="next"' }
        })
    )

    const result = await apiCallTool.execute(
      { connection: conn.name, path: '/x', paginate: true, maxPages: 2 },
      {} as never
    )

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
    expect(result).toContain('2 page(s), 2 item(s) total')
  })

  it('reports plainly when paginate is requested but the body has no recognizable list shape', async () => {
    const conn = saveApiConnection({ name: 'J', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const result = await apiCallTool.execute({ connection: conn.name, path: '/x', paginate: true }, {} as never)

    expect(result).toMatch(/isn't a recognizable list shape/)
  })
})
