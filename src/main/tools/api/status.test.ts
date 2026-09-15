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
const { apiCheckStatusTool } = await import('./status')

describe('api_check_status', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-api-status-'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('is never mutating', () => {
    expect(apiCheckStatusTool.mutates).toBe(false)
  })

  it('returns a friendly message for an unknown connection', async () => {
    const result = await apiCheckStatusTool.execute({ connection: 'nope', statusUrl: '/x' }, {} as never)
    expect(result).toMatch(/No API connection named "nope"/)
  })

  it('rejects a missing statusUrl', async () => {
    const conn = saveApiConnection({ name: 'A', baseUrl: 'https://api.example.com', authType: 'none' })
    await expect(apiCheckStatusTool.execute({ connection: conn.name }, {} as never)).rejects.toThrow(/No statusUrl given/)
  })

  it('returns immediately on a terminal success status, with one poll', async () => {
    const conn = saveApiConnection({ name: 'B', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 'succeeded', result: 42 }), { status: 200 })
    )

    const result = await apiCheckStatusTool.execute({ connection: conn.name, statusUrl: '/jobs/1' }, {} as never)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result).toMatch(/job status: succeeded/)
    expect(result).toContain('"result": 42')
  })

  it('treats a body with no status field as terminal (returned as-is, not polled)', async () => {
    const conn = saveApiConnection({ name: 'C', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await apiCheckStatusTool.execute({ connection: conn.name, statusUrl: '/x' }, {} as never)

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stops on a terminal failure status too, not just success', async () => {
    const conn = saveApiConnection({ name: 'D', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: 'failed', error: 'boom' }), { status: 200 }))

    const result = await apiCheckStatusTool.execute({ connection: conn.name, statusUrl: '/x' }, {} as never)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result).toMatch(/job status: failed/)
  })

  it('polls again while pending, then returns once terminal', async () => {
    const conn = saveApiConnection({ name: 'E', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'running' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', result: 'done' }), { status: 200 }))

    const result = await apiCheckStatusTool.execute(
      { connection: conn.name, statusUrl: '/jobs/1', intervalMs: 5 },
      {} as never
    )

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toMatch(/job status: completed/)
  })

  it('reports still-pending once maxAttempts is exhausted, without throwing', async () => {
    const conn = saveApiConnection({ name: 'F', baseUrl: 'https://api.example.com', authType: 'none' })
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ status: 'pending' }), { status: 200 }))

    const result = await apiCheckStatusTool.execute(
      { connection: conn.name, statusUrl: '/jobs/1', maxAttempts: 2, intervalMs: 5 },
      {} as never
    )

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toMatch(/Still pending after 2 poll\(s\)/)
    expect(result).toContain('statusUrl ("/jobs/1")')
  })
})
