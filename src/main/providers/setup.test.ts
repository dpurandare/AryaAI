import { describe, expect, it, vi } from 'vitest'

// probeEmbeddingDimension only needs OllamaProvider for this test, which itself only needs the `openai`
// SDK mocked (no electron/keychain involved) — same minimal mock ollama.test.ts already uses.
const mockCreate = vi.fn()
const FakeOpenAI = vi.fn().mockImplementation(function FakeOpenAI() {
  return { embeddings: { create: mockCreate } }
})
vi.mock('openai', () => ({ default: FakeOpenAI }))

const { probeEmbeddingDimension } = await import('./setup')

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
