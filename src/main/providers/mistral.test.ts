import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, StreamEvent } from './types'

const mockCreate = vi.fn()
const mockList = vi.fn()
const mockEmbeddingsCreate = vi.fn()
const capturedConstructorArgs: unknown[] = []

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(function FakeOpenAI(args: unknown) {
      capturedConstructorArgs.push(args)
      return {
        chat: { completions: { create: mockCreate } },
        models: { list: mockList },
        embeddings: { create: mockEmbeddingsCreate }
      }
    })
  }
})

// Imported after the mock so the class picks up the mocked SDK.
const { MistralProvider } = await import('./mistral')

async function* fakeStream(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('MistralProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockList.mockReset()
    mockEmbeddingsCreate.mockReset()
    capturedConstructorArgs.length = 0
  })

  it("points the OpenAI SDK at Mistral's own OpenAI-compatible base URL, with the real API key", () => {
    new MistralProvider('mistral-key-abc')
    expect(capturedConstructorArgs).toEqual([{ apiKey: 'mistral-key-abc', baseURL: 'https://api.mistral.ai/v1' }])
  })

  it("streams text deltas and a final end_turn stop with usage — identical shape to OpenAI's own wire format", async () => {
    mockCreate.mockResolvedValue(
      fakeStream([
        { choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'lo!' }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 }
        }
      ])
    )

    const provider = new MistralProvider('key')
    const events = await collect(provider.stream({ model: 'mistral-large-latest', messages: [], maxTokens: 100 }))

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo!' },
      { type: 'usage', inputTokens: 12, outputTokens: 3 },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  it('streams a tool call across incremental argument chunks', async () => {
    mockCreate.mockResolvedValue(
      fakeStream([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }, finish_reason: null }
          ]
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ])
    )

    const provider = new MistralProvider('key')
    const events = await collect(provider.stream({ model: 'mistral-large-latest', messages: [], maxTokens: 100 }))

    expect(events).toEqual([
      { type: 'tool_use_start', id: 'call_1', name: 'write_file' },
      { type: 'tool_use_delta', id: 'call_1', partialInput: '{"path":"a.txt"}' },
      { type: 'message_stop', stopReason: 'tool_use' }
    ])
  })

  it('maps finish_reason "length" to max_tokens', async () => {
    mockCreate.mockResolvedValue(fakeStream([{ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }]))
    const provider = new MistralProvider('key')
    const events = await collect(provider.stream({ model: 'mistral-large-latest', messages: [], maxTokens: 100 }))
    expect(events).toEqual([{ type: 'message_stop', stopReason: 'max_tokens' }])
  })

  it('maps the request: system prompt, tool_result -> role tool, assistant tool_use -> tool_calls', async () => {
    mockCreate.mockResolvedValue(fakeStream([]))
    const provider = new MistralProvider('key')
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'wrote it' }] }
    ]

    await collect(provider.stream({ model: 'mistral-large-latest', system: 'be helpful', messages, maxTokens: 100 }))

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const sentMessages = mockCreate.mock.calls[0][0].messages
    expect(sentMessages).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'wrote it' }
    ])
  })

  it('lists model ids from the real /v1/models endpoint', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'mistral-large-latest' }, { id: 'mistral-small-latest' }] })
    const provider = new MistralProvider('key')
    expect(await provider.listModels()).toEqual(['mistral-large-latest', 'mistral-small-latest'])
  })

  it('counts tokens via a real tiktoken estimate, not a stub', async () => {
    const provider = new MistralProvider('key')
    const short = await provider.countTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    const long = await provider.countTokens([{ role: 'user', content: [{ type: 'text', text: 'hi '.repeat(200) }] }])
    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
  })

  it('embeds text via the real /v1/embeddings endpoint (mistral-embed)', async () => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] })
    const provider = new MistralProvider('key')
    const result = await provider.embed(['a', 'b'], 'mistral-embed')
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]])
    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({ model: 'mistral-embed', input: ['a', 'b'] })
  })

  describe('loadedContextWindow', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("returns the model's real, provider-reported max_context_length, not a guess", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: [
              { id: 'mistral-large-latest', max_context_length: 128000 },
              { id: 'mistral-small-latest', max_context_length: 32768 }
            ]
          })
        })
      )
      const provider = new MistralProvider('key')
      expect(await provider.loadedContextWindow('mistral-large-latest')).toBe(128000)
    })

    it('queries GET /v1/models with a real Bearer auth header', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
      vi.stubGlobal('fetch', fetchMock)
      const provider = new MistralProvider('the-real-key')
      await provider.loadedContextWindow('mistral-large-latest')
      expect(fetchMock).toHaveBeenCalledWith('https://api.mistral.ai/v1/models', {
        headers: { Authorization: 'Bearer the-real-key' }
      })
    })

    it('returns undefined for a model id not present in the response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'mistral-small-latest', max_context_length: 32768 }] }) })
      )
      const provider = new MistralProvider('key')
      expect(await provider.loadedContextWindow('mistral-large-latest')).toBeUndefined()
    })

    it('returns undefined on a non-ok response instead of throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
      const provider = new MistralProvider('key')
      expect(await provider.loadedContextWindow('mistral-large-latest')).toBeUndefined()
    })

    it('returns undefined when the server is unreachable instead of throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const provider = new MistralProvider('key')
      expect(await provider.loadedContextWindow('mistral-large-latest')).toBeUndefined()
    })
  })
})
