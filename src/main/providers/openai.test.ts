import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, StreamEvent } from './types'

const mockCreate = vi.fn()
const mockList = vi.fn()

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(function FakeOpenAI() {
      return {
        chat: { completions: { create: mockCreate } },
        models: { list: mockList }
      }
    })
  }
})

// Imported after the mock so the class picks up the mocked SDK.
const { OpenAIProvider } = await import('./openai')

async function* fakeStream(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('OpenAIProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockList.mockReset()
  })

  it('streams text deltas and a final end_turn stop with usage', async () => {
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

    const provider = new OpenAIProvider('key')
    const events = await collect(
      provider.stream({ model: 'gpt-4o', messages: [], maxTokens: 100 })
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

    const provider = new OpenAIProvider('key')
    const events = await collect(
      provider.stream({ model: 'gpt-4o', messages: [], maxTokens: 100 })
    )

    expect(events).toEqual([
      { type: 'tool_use_start', id: 'call_1', name: 'write_file' },
      { type: 'tool_use_delta', id: 'call_1', partialInput: '{"path":"a.txt"}' },
      { type: 'message_stop', stopReason: 'tool_use' }
    ])
  })

  it('maps finish_reason "length" to max_tokens', async () => {
    mockCreate.mockResolvedValue(fakeStream([{ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }]))
    const provider = new OpenAIProvider('key')
    const events = await collect(provider.stream({ model: 'gpt-4o', messages: [], maxTokens: 100 }))
    expect(events).toEqual([{ type: 'message_stop', stopReason: 'max_tokens' }])
  })

  it('maps the request: system prompt, tool_result -> role tool, assistant tool_use -> tool_calls', async () => {
    mockCreate.mockResolvedValue(fakeStream([]))
    const provider = new OpenAIProvider('key')
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

    await collect(provider.stream({ model: 'gpt-4o', system: 'be helpful', messages, maxTokens: 100 }))

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

  it('never sends a warning or image block back to the model — both are human-facing only (TASKS.md #82/#102)', async () => {
    mockCreate.mockResolvedValue(fakeStream([]))
    const provider = new OpenAIProvider('key')
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'show me chart.png' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'show_media', input: { path: 'chart.png' } }]
      },
      {
        role: 'user',
        content: [
          { type: 'image', toolUseId: 'call_1', path: 'chart.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' },
          { type: 'tool_result', toolUseId: 'call_1', content: 'Displayed chart.png to the user.' }
        ]
      },
      { role: 'assistant', content: [{ type: 'warning', message: 'context trimmed' }] }
    ]

    await collect(provider.stream({ model: 'gpt-4o', messages, maxTokens: 100 }))

    const sentMessages = mockCreate.mock.calls[0][0].messages
    // The warning-only assistant message is dropped entirely (no empty
    // turn); the tool_result survives, but the image block never appears
    // anywhere in what's sent — no data: URI, no base64 payload at all.
    expect(sentMessages).toEqual([
      { role: 'user', content: 'show me chart.png' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'show_media', arguments: '{"path":"chart.png"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Displayed chart.png to the user.' }
    ])
    expect(JSON.stringify(sentMessages)).not.toContain('aGVsbG8=')
  })

  it('lists model ids', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
    const provider = new OpenAIProvider('key')
    expect(await provider.listModels()).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('counts tokens via a real tiktoken estimate, not a stub', async () => {
    const provider = new OpenAIProvider('key')
    const short = await provider.countTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    const long = await provider.countTokens([
      { role: 'user', content: [{ type: 'text', text: 'hi '.repeat(200) }] }
    ])
    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
  })
})
