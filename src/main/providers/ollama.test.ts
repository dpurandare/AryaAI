import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})
