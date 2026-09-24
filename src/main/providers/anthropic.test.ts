import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, StreamEvent } from './types'

const mockStream = vi.fn()
const mockList = vi.fn()
const mockCountTokens = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(function FakeAnthropic() {
      return {
        messages: { stream: mockStream, countTokens: mockCountTokens },
        models: { list: mockList }
      }
    })
  }
})

// Imported after the mock so the class picks up the mocked SDK.
const { AnthropicProvider } = await import('./anthropic')

function fakeStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e
    }
  }
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('AnthropicProvider', () => {
  beforeEach(() => {
    mockStream.mockReset()
    mockList.mockReset()
    mockCountTokens.mockReset()
  })

  it('streams text deltas, usage (including message_start input tokens), and a final end_turn stop', async () => {
    mockStream.mockReturnValue(
      fakeStream([
        { type: 'message_start', message: { usage: { input_tokens: 23 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo!' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }
      ])
    )

    const provider = new AnthropicProvider('key')
    const events = await collect(
      provider.stream({ model: 'claude-sonnet-5', messages: [], maxTokens: 100 })
    )

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo!' },
      { type: 'usage', inputTokens: 23, outputTokens: 5 },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  it('streams a tool call: start then incremental input_json_delta', async () => {
    mockStream.mockReturnValue(
      fakeStream([
        { type: 'message_start', message: { usage: { input_tokens: 17 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_1', name: 'write_file' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' }
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }
      ])
    )

    const provider = new AnthropicProvider('key')
    const events = await collect(
      provider.stream({ model: 'claude-sonnet-5', messages: [], maxTokens: 100 })
    )

    expect(events).toEqual([
      { type: 'tool_use_start', id: 'call_1', name: 'write_file' },
      { type: 'tool_use_delta', id: 'call_1', partialInput: '{"path":"a.txt"}' },
      { type: 'usage', inputTokens: 17, outputTokens: 8 },
      { type: 'message_stop', stopReason: 'tool_use' }
    ])
  })

  it('reports inputTokens as 0 if message_start never arrived (defensive default, not expected in practice)', async () => {
    mockStream.mockReturnValue(
      fakeStream([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }])
    )
    const provider = new AnthropicProvider('key')
    const events = await collect(provider.stream({ model: 'claude-sonnet-5', messages: [], maxTokens: 100 }))
    expect(events).toContainEqual({ type: 'usage', inputTokens: 0, outputTokens: 3 })
  })

  it('maps stop_reason "max_tokens"', async () => {
    mockStream.mockReturnValue(
      fakeStream([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }])
    )
    const provider = new AnthropicProvider('key')
    const events = await collect(provider.stream({ model: 'claude-sonnet-5', messages: [], maxTokens: 100 }))
    expect(events.at(-1)).toEqual({ type: 'message_stop', stopReason: 'max_tokens' })
  })

  it('maps ContentBlocks to Anthropic message params, including tool_result is_error', async () => {
    mockStream.mockReturnValue(fakeStream([]))
    const provider = new AnthropicProvider('key')
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'boom', isError: true }]
      }
    ]

    await collect(provider.stream({ model: 'claude-sonnet-5', system: 'be helpful', messages, maxTokens: 100 }))

    expect(mockStream).toHaveBeenCalledTimes(1)
    const sent = mockStream.mock.calls[0][0]
    expect(sent.system).toBe('be helpful')
    expect(sent.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'boom', is_error: true }]
      }
    ])
  })

  it('never sends a warning or image block back to the model — both are human-facing only (TASKS.md #82/#102)', async () => {
    mockStream.mockReturnValue(fakeStream([]))
    const provider = new AnthropicProvider('key')
    const messages: Message[] = [
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

    await collect(provider.stream({ model: 'claude-sonnet-5', messages, maxTokens: 100 }))

    const sent = mockStream.mock.calls[0][0].messages
    // The warning-only assistant message is dropped entirely (empty
    // content); the tool_result survives, but the image block never
    // appears anywhere in what's sent — no base64 payload at all.
    expect(sent).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'show_media', input: { path: 'chart.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Displayed chart.png to the user.', is_error: undefined }] }
    ])
    expect(JSON.stringify(sent)).not.toContain('aGVsbG8=')
  })

  it('lists model ids', async () => {
    mockList.mockResolvedValue({ data: [{ id: 'claude-sonnet-5' }, { id: 'claude-fable-5-1' }] })
    const provider = new AnthropicProvider('key')
    expect(await provider.listModels()).toEqual(['claude-sonnet-5', 'claude-fable-5-1'])
  })

  it('counts tokens via the SDK', async () => {
    mockCountTokens.mockResolvedValue({ input_tokens: 42 })
    const provider = new AnthropicProvider('key')
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    expect(await provider.countTokens(messages, 'claude-sonnet-5')).toBe(42)
  })
})
