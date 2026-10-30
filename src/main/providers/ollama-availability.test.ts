import { describe, expect, it, vi } from 'vitest'
import { OllamaAvailability } from './ollama-availability'

const ok = (): Response => ({ ok: true, status: 200 }) as Response

describe('OllamaAvailability (#214)', () => {
  it('reports reachable and probes /api/version on the root address (the /v1 suffix is dropped)', async () => {
    const f = vi.fn().mockResolvedValue(ok())
    const r = await new OllamaAvailability(f).check('http://localhost:11434/v1')
    expect(r).toEqual({ reachable: true, address: 'http://localhost:11434' })
    expect(f.mock.calls[0][0]).toBe('http://localhost:11434/api/version')
  })

  it('reports a connection failure in plain words', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const r = await new OllamaAvailability(f).check('http://localhost:11434/v1')
    expect(r.reachable).toBe(false)
    expect(r.error).toMatch(/does not seem to be running/)
  })

  it('reports a timeout and a non-Ollama answer differently', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
    expect((await new OllamaAvailability(vi.fn().mockRejectedValue(timeout)).check('http://x:1/v1')).error).toMatch(/within 1.5 seconds/)
    const notOllama = await new OllamaAvailability(vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response)).check('http://x:1/v1')
    expect(notOllama.error).toMatch(/did not look like Ollama \(HTTP 404\)/)
  })

  it('caches for a few seconds per address, and force skips the cache', async () => {
    let t = 1000
    const f = vi.fn().mockResolvedValue(ok())
    const a = new OllamaAvailability(f, () => t)
    await a.check('http://h:1/v1')
    await a.check('http://h:1/v1')
    expect(f).toHaveBeenCalledTimes(1)
    await a.check('http://other:1/v1')
    expect(f).toHaveBeenCalledTimes(2)
    await a.check('http://other:1/v1', true)
    expect(f).toHaveBeenCalledTimes(3)
    t += 6000
    await a.check('http://other:1/v1')
    expect(f).toHaveBeenCalledTimes(4)
  })
})
