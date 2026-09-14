import { describe, expect, it } from 'vitest'
import type { Message } from './types'
import { toOpenAIMessages } from './openai-compatible'

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
