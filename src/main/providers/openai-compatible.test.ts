import { describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import type { Message, StreamEvent } from './types'
import { streamOpenAICompatible, toOpenAIMessages } from './openai-compatible'

/** A minimal stand-in for the OpenAI SDK's async-iterable chat completion stream. */
function fakeClient(chunks: unknown[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({
          [Symbol.asyncIterator]: async function* () {
            for (const chunk of chunks) yield chunk
          }
        })
      }
    }
  } as unknown as OpenAI
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('toOpenAIMessages', () => {
  it('converts ordinary text/tool_use/tool_result messages as a baseline', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'contents' }] }
    ]
    const result = toOpenAIMessages(undefined, messages)
    expect(result).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' }
    ])
  })

  it('drops a warning-only assistant message entirely instead of sending an empty shell', () => {
    // Real bug, found live: {content: null, tool_calls: undefined} — what
    // this used to produce for a warning-only message — got a genuine 400
    // from Ollama's OpenAI-compat layer ("invalid message content type")
    // the next time this session's history was sent. A warning is a
    // human-facing notice, never something the model itself said, so it
    // must never round-trip back to the model as its own past turn.
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'warning', message: 'something was cut off' }] },
      { role: 'user', content: [{ type: 'text', text: 'still there?' }] }
    ]
    const result = toOpenAIMessages(undefined, messages)
    expect(result).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'still there?' }
    ])
    expect(result.some((m) => m.role === 'assistant')).toBe(false)
  })

  it('keeps a message that mixes a warning with real text or a real tool call, dropping only the warning part', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'partial answer' },
          { type: 'warning', message: 'this response was cut off' }
        ]
      }
    ]
    const result = toOpenAIMessages(undefined, messages)
    expect(result).toEqual([{ role: 'assistant', content: 'partial answer', tool_calls: undefined }])
  })
})

describe('streamOpenAICompatible', () => {
  const baseRequest = { model: 'gpt-oss-custom:latest', messages: [] as Message[], maxTokens: 100 }

  it('passes through the real message_stop when the server sends one', async () => {
    const client = fakeClient([
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ])
    const events = await collect(streamOpenAICompatible(client, baseRequest))
    expect(events).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  it('synthesizes a message_stop when the stream ends without one — the real bug found live against Ollama/gpt-oss: the server closed the connection mid-turn with no finish_reason, which left the whole chat turn stuck on "Thinking" forever (nothing left running to error out or to Stop/cancel, since the round had already completed from this generator\'s point of view)', async () => {
    const client = fakeClient([{ choices: [{ delta: { content: 'partial' } }] }])
    const events = await collect(streamOpenAICompatible(client, baseRequest))
    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  it('synthesizes a message_stop even for a completely empty stream (no chunks at all)', async () => {
    const client = fakeClient([])
    const events = await collect(streamOpenAICompatible(client, baseRequest))
    expect(events).toEqual([{ type: 'message_stop', stopReason: 'end_turn' }])
  })
})
