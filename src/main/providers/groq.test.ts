import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, StreamEvent } from './types'

const mockCreate = vi.fn()
const mockList = vi.fn()
const capturedConstructorArgs: unknown[] = []

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(function FakeOpenAI(args: unknown) {
      capturedConstructorArgs.push(args)
      return {
        chat: { completions: { create: mockCreate } },
        models: { list: mockList }
      }
    })
  }
})

// Imported after the mock so the class picks up the mocked SDK.
const { GroqProvider } = await import('./groq')

async function* fakeStream(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('GroqProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockList.mockReset()
    capturedConstructorArgs.length = 0
  })

  it('points the OpenAI SDK at Groq\'s own OpenAI-compatible base URL, with the real API key', () => {
    new GroqProvider('groq-key-abc')
    expect(capturedConstructorArgs).toEqual([{ apiKey: 'groq-key-abc', baseURL: 'https://api.groq.com/openai/v1' }])
  })

  it('streams text deltas and a final end_turn stop with usage — identical shape to OpenAI\'s own wire format', async () => {
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

    const provider = new GroqProvider('key')
    const events = await collect(
      provider.stream({ model: 'llama-3.3-70b-versatile', messages: [], maxTokens: 100 })
    )

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

    const provider = new GroqProvider('key')
    const events = await collect(
      provider.stream({ model: 'llama-3.3-70b-versatile', messages: [], maxTokens: 100 })
    )

    expect(events).toEqual([
      { type: 'tool_use_start', id: 'call_1', name: 'write_file' },
      { type: 'tool_use_delta', id: 'call_1', partialInput: '{"path":"a.txt"}' },
      { type: 'message_stop', stopReason: 'tool_use' }
    ])
  })

  it('maps finish_reason "length" to max_tokens', async () => {
    mockCreate.mockResolvedValue(fakeStream([{ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }]))
    const provider = new GroqProvider('key')
    const events = await collect(provider.stream({ model: 'llama-3.3-70b-versatile', messages: [], maxTokens: 100 }))
    expect(events).toEqual([{ type: 'message_stop', stopReason: 'max_tokens' }])
  })

  it('maps the request: system prompt, tool_result -> role tool, assistant tool_use -> tool_calls', async () => {
    mockCreate.mockResolvedValue(fakeStream([]))
    const provider = new GroqProvider('key')
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

    await collect(provider.stream({ model: 'llama-3.3-70b-versatile', system: 'be helpful', messages, maxTokens: 100 }))

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
    mockList.mockResolvedValue({
      data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-120b' }]
    })
    const provider = new GroqProvider('key')
    expect(await provider.listModels()).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'])
  })

  it('counts tokens via a real tiktoken estimate, not a stub', async () => {
    const provider = new GroqProvider('key')
    const short = await provider.countTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    const long = await provider.countTokens([
      { role: 'user', content: [{ type: 'text', text: 'hi '.repeat(200) }] }
    ])
    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
  })

  it('does not implement EmbeddingProvider — Groq has no embeddings endpoint', async () => {
    const provider = new GroqProvider('key')
    expect((provider as unknown as { embed?: unknown }).embed).toBeUndefined()
  })
})
