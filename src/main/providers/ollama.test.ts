import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from './types'

const mockCreate = vi.fn()
const mockList = vi.fn()
const FakeOpenAI = vi.fn().mockImplementation(function FakeOpenAI(config: unknown) {
  return {
    config,
    chat: { completions: { create: mockCreate } },
    models: { list: mockList }
  }
})

vi.mock('openai', () => ({ default: FakeOpenAI }))

// Imported after the mock so the class picks up the mocked SDK.
const { OllamaProvider } = await import('./ollama')

async function* fakeStream(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('OllamaProvider', () => {
  beforeEach(() => {
    FakeOpenAI.mockClear()
    mockCreate.mockReset()
    mockList.mockReset()
  })

  it('points the OpenAI client at the local Ollama server with a placeholder key', () => {
    new OllamaProvider()
    expect(FakeOpenAI).toHaveBeenCalledWith({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' })
  })

  it('accepts a custom base URL', () => {
    new OllamaProvider('http://example.internal:11434/v1')
    expect(FakeOpenAI).toHaveBeenCalledWith({
      apiKey: 'ollama',
      baseURL: 'http://example.internal:11434/v1'
    })
  })

  it('defaults to reporting itself as local Ollama (#167 backward compat)', () => {
    const provider = new OllamaProvider()
    expect(provider.id).toBe('ollama')
    expect(provider.displayName).toBe('Ollama (local)')
  })

  it('serves Ollama Cloud with a real key and its own id/displayName (#167)', () => {
    const provider = new OllamaProvider('https://ollama.com/v1', 'real-cloud-key', 'ollama-cloud', 'Ollama Cloud')
    expect(FakeOpenAI).toHaveBeenCalledWith({ apiKey: 'real-cloud-key', baseURL: 'https://ollama.com/v1' })
    expect(provider.id).toBe('ollama-cloud')
    expect(provider.displayName).toBe('Ollama Cloud')
  })

  it('streams via the same OpenAI-compatible translation as OpenAIProvider', async () => {
    mockCreate.mockResolvedValue(
      fakeStream([
        { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ])
    )

    const provider = new OllamaProvider()
    const events = await collect(provider.stream({ model: 'gpt-oss:20b', messages: [], maxTokens: 100 }))

    expect(events).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  it('counts tokens via a real tiktoken estimate, not a stub', async () => {
    const provider = new OllamaProvider()
    const count = await provider.countTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(count).toBeGreaterThan(0)
  })

  it('lists model ids from the local server', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'gpt-oss:20b' }, { id: 'gemma4:latest' }] })
    const provider = new OllamaProvider()
    expect(await provider.listModels()).toEqual(['gpt-oss:20b', 'gemma4:latest'])
  })

  describe('loadedContextWindow', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns the real runtime context for a currently-loaded model, not its architectural max', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            models: [
              { model: 'gpt-oss:20b', context_length: 4096 },
              { model: 'nomic-embed-text:latest', context_length: 2048 }
            ]
          })
        })
      )
      const provider = new OllamaProvider()
      expect(await provider.loadedContextWindow('gpt-oss:20b')).toBe(4096)
    })

    it('queries the native /api/ps endpoint, not the OpenAI-compat /v1 path', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) })
      vi.stubGlobal('fetch', fetchMock)
      const provider = new OllamaProvider('http://example.internal:11434/v1')
      await provider.loadedContextWindow('gpt-oss:20b')
      expect(fetchMock).toHaveBeenCalledWith('http://example.internal:11434/api/ps')
    })

    it('returns undefined when the model is not currently loaded', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ model: 'gemma4:latest', context_length: 131072 }] }) })
      )
      const provider = new OllamaProvider()
      expect(await provider.loadedContextWindow('gpt-oss:20b')).toBeUndefined()
    })

    it('returns undefined on a non-ok response instead of throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
      const provider = new OllamaProvider()
      expect(await provider.loadedContextWindow('gpt-oss:20b')).toBeUndefined()
    })

    it('returns undefined when the server is unreachable instead of throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const provider = new OllamaProvider()
      expect(await provider.loadedContextWindow('gpt-oss:20b')).toBeUndefined()
    })
  })

  describe('configuredContextWindow', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("parses num_ctx out of /api/show's plain whitespace-aligned parameters block", async () => {
      // Real shape confirmed live against a custom Modelfile, not guessed —
      // `parameters` is plain text, not structured JSON.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ parameters: 'num_ctx                        131072\ntemperature                    1' })
        })
      )
      const provider = new OllamaProvider()
      expect(await provider.configuredContextWindow('gpt-oss-custom:latest')).toBe(131072)
    })

    it('works for a model with no other parameters set', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ parameters: 'num_ctx    4096' }) }))
      const provider = new OllamaProvider()
      expect(await provider.configuredContextWindow('x')).toBe(4096)
    })

    it('returns undefined when the Modelfile sets no num_ctx at all', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ parameters: 'temperature   1' }) }))
      const provider = new OllamaProvider()
      expect(await provider.configuredContextWindow('x')).toBeUndefined()
    })

    it('returns undefined when parameters is absent entirely', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
      const provider = new OllamaProvider()
      expect(await provider.configuredContextWindow('x')).toBeUndefined()
    })

    it('queries the native /api/show endpoint with the model in the POST body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ parameters: 'num_ctx 4096' }) })
      vi.stubGlobal('fetch', fetchMock)
      const provider = new OllamaProvider('http://example.internal:11434/v1')
      await provider.configuredContextWindow('gpt-oss-custom:latest')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://example.internal:11434/api/show',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'gpt-oss-custom:latest' }) })
      )
    })

    it('returns undefined on a non-ok response instead of throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
      const provider = new OllamaProvider()
      expect(await provider.configuredContextWindow('x')).toBeUndefined()
    })

    it('returns undefined when the server is unreachable instead of throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const provider = new OllamaProvider()
      expect(await provider.configuredContextWindow('x')).toBeUndefined()
    })
  })

  it('says plainly that Ollama is not running when the connection fails (#214), only for the local provider', async () => {
    const connErr = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })
    mockCreate.mockRejectedValue(connErr)
    const req = { model: 'm', messages: [], tools: [] } as never
    await expect(collect(new OllamaProvider().stream(req))).rejects.toThrow(/Ollama \(local\) is not running at http:\/\/localhost:11434/)
    await expect(collect(new OllamaProvider('https://ollama.com/v1', 'k', 'ollama-cloud', 'Ollama Cloud').stream(req))).rejects.toThrow(/Connection error/)
  })

  it('modelDigest reads the digest from /api/tags, matching the bare name to :latest (#224)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'other:1b', digest: 'x' }, { name: 'nomic-embed-text:latest', digest: 'abc123' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const p = new OllamaProvider('http://localhost:11450/v1')
    expect(await p.modelDigest('nomic-embed-text')).toBe('abc123')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11450/api/tags')
    expect(await p.modelDigest('missing')).toBeUndefined()
    fetchMock.mockRejectedValue(new Error('down'))
    expect(await p.modelDigest('nomic-embed-text')).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
