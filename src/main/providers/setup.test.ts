import { afterEach, describe, expect, it, vi } from 'vitest'

// probeEmbeddingDimension only needs OllamaProvider for this test, which itself only needs the `openai`
// SDK mocked (no electron/keychain involved) — same minimal mock ollama.test.ts already uses.
const mockCreate = vi.fn()
const FakeOpenAI = vi.fn().mockImplementation(function FakeOpenAI() {
  return { embeddings: { create: mockCreate } }
})
vi.mock('openai', () => ({ default: FakeOpenAI }))

const { probeEmbeddingDimension, createDefaultProviderRegistry, getEmbeddingProvider, setBundledOllamaBaseUrl, setOllamaChatBaseUrl, getOllamaChatBaseUrl } = await import('./setup')

describe('probeEmbeddingDimension (#162)', () => {
  it('returns the real vector length from a live embed call, not a guessed/hardcoded value', async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: new Array(768).fill(0.1) }] })
    const dimension = await probeEmbeddingDimension('ollama', undefined, 'nomic-embed-text')
    expect(dimension).toBe(768)
    expect(mockCreate).toHaveBeenCalledWith({ model: 'nomic-embed-text', input: ['test'] })
  })

  it('propagates a real failure (e.g. an unknown model) rather than silently returning a guess', async () => {
    mockCreate.mockRejectedValue(new Error('model "bogus-model" not found'))
    await expect(probeEmbeddingDimension('ollama', undefined, 'bogus-model')).rejects.toThrow(/not found/)
  })
})

describe('Ollama routing (#214): chat uses the user\'s Ollama, embeddings use the bundled one', () => {
  afterEach(() => {
    setBundledOllamaBaseUrl(undefined)
    setOllamaChatBaseUrl(undefined)
    FakeOpenAI.mockClear()
  })
  const lastBaseUrl = (): string => (FakeOpenAI.mock.calls.at(-1)?.[0] as { baseURL: string }).baseURL

  it('chat defaults to localhost:11434 even when the bundled server is up', () => {
    setBundledOllamaBaseUrl('http://127.0.0.1:11450')
    createDefaultProviderRegistry().get('ollama')!.create()
    expect(lastBaseUrl()).toBe('http://localhost:11434/v1')
  })

  it('embeddings go to the bundled server when there is one, and to the user\'s Ollama otherwise', () => {
    setBundledOllamaBaseUrl('http://127.0.0.1:11450')
    getEmbeddingProvider('ollama')
    expect(lastBaseUrl()).toBe('http://127.0.0.1:11450/v1')
    setBundledOllamaBaseUrl(undefined)
    getEmbeddingProvider('ollama')
    expect(lastBaseUrl()).toBe('http://localhost:11434/v1')
  })

  it('a configured address is used for chat, with or without /v1 and trailing slashes; empty resets to the default', () => {
    setOllamaChatBaseUrl('http://gpu-box:11434/')
    expect(getOllamaChatBaseUrl()).toBe('http://gpu-box:11434/v1')
    setOllamaChatBaseUrl('http://gpu-box:11434/v1')
    createDefaultProviderRegistry().get('ollama')!.create()
    expect(lastBaseUrl()).toBe('http://gpu-box:11434/v1')
    setOllamaChatBaseUrl('  ')
    expect(getOllamaChatBaseUrl()).toBe('http://localhost:11434/v1')
  })
})
