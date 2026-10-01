import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, StreamEvent } from './types'

const mockGenerateContentStream = vi.fn()
const mockList = vi.fn()
const mockCountTokens = vi.fn()

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>()
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(function FakeGoogleGenAI() {
      return {
        models: {
          generateContentStream: mockGenerateContentStream,
          list: mockList,
          countTokens: mockCountTokens
        }
      }
    })
  }
})

// Imported after the mock so the class picks up the mocked SDK.
const { GoogleProvider } = await import('./google')

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

describe('GoogleProvider', () => {
  beforeEach(() => {
    mockGenerateContentStream.mockReset()
    mockList.mockReset()
    mockCountTokens.mockReset()
  })

  it('streams text deltas and a final end_turn stop with usage', async () => {
    mockGenerateContentStream.mockResolvedValue(
      fakeStream([
        { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'lo!' }] } }] },
        {
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 }
        }
      ])
    )

    const provider = new GoogleProvider('key')
    const events = await collect(
      provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100 })
    )

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo!' },
      { type: 'usage', inputTokens: 12, outputTokens: 3 },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  // TASKS.md #147
  it('requests thought summaries via thinkingConfig.includeThoughts — opt-in, Gemini does not stream them by default', async () => {
    mockGenerateContentStream.mockResolvedValue(fakeStream([{ candidates: [{ finishReason: 'STOP' }] }]))
    const provider = new GoogleProvider('key')
    await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100 }))
    const params = mockGenerateContentStream.mock.calls[0][0]
    expect(params.config.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('sends temperature when the request sets it, and omits it entirely when it does not', async () => {
    mockGenerateContentStream.mockResolvedValue(fakeStream([{ candidates: [{ finishReason: 'STOP' }] }]))
    const provider = new GoogleProvider('key')
    await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100 }))
    expect(mockGenerateContentStream.mock.calls[0][0].config).not.toHaveProperty('temperature')
    await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100, temperature: 0.2 }))
    expect(mockGenerateContentStream.mock.calls[1][0].config.temperature).toBe(0.2)
  })

  it('routes a part.thought=true part to thinking_delta, keeping it separate from real answer text', async () => {
    mockGenerateContentStream.mockResolvedValue(
      fakeStream([
        { candidates: [{ content: { parts: [{ text: 'considering the request', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Here is the answer.' }] } }] },
        { candidates: [{ finishReason: 'STOP' }] }
      ])
    )
    const provider = new GoogleProvider('key')
    const events = await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100 }))
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'considering the request' },
      { type: 'text_delta', text: 'Here is the answer.' },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  it('a model that does not return any thought parts (e.g. gemini-flash-lite) just never emits thinking_delta — no error, no special-casing needed', async () => {
    mockGenerateContentStream.mockResolvedValue(
      fakeStream([
        { candidates: [{ content: { parts: [{ text: 'Straight to the answer.' }] } }] },
        { candidates: [{ finishReason: 'STOP' }] }
      ])
    )
    const provider = new GoogleProvider('key')
    const events = await collect(provider.stream({ model: 'gemini-flash-lite', messages: [], maxTokens: 100 }))
    expect(events).toEqual([
      { type: 'text_delta', text: 'Straight to the answer.' },
      { type: 'message_stop', stopReason: 'end_turn' }
    ])
  })

  it('reports the cached part of the prompt (Gemini implicit caching) without changing inputTokens, and omits the key when nothing was cached', async () => {
    mockGenerateContentStream.mockResolvedValueOnce(
      fakeStream([{ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 4, cachedContentTokenCount: 2500 } }])
    )
    const provider = new GoogleProvider('key')
    expect(await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 10 }))).toContainEqual({ type: 'usage', inputTokens: 3000, outputTokens: 4, cacheReadTokens: 2500 })

    mockGenerateContentStream.mockResolvedValueOnce(
      fakeStream([{ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2, cachedContentTokenCount: 0 } }])
    )
    expect(await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 10 }))).toContainEqual({ type: 'usage', inputTokens: 50, outputTokens: 2 })
  })

  it('streams a tool call whose finishReason arrives in a later, call-free chunk (the real shape, confirmed live)', async () => {
    mockGenerateContentStream.mockResolvedValue(
      fakeStream([
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { id: 'call_1', name: 'write_file', args: { path: 'a.txt' } } }]
              }
            }
          ]
        },
        { candidates: [{ finishReason: 'STOP' }] }
      ])
    )

    const provider = new GoogleProvider('key')
    const events = await collect(
      provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100 })
    )

    expect(events).toEqual([
      { type: 'tool_use_start', id: 'call_1', name: 'write_file' },
      { type: 'tool_use_delta', id: 'call_1', partialInput: '{"path":"a.txt"}' },
      { type: 'message_stop', stopReason: 'tool_use' }
    ])
  })

  it('carries thoughtSignature from the functionCall part onto tool_use_start (Gemini 400s on the next turn without it, confirmed live)', async () => {
    mockGenerateContentStream.mockResolvedValue(
      fakeStream([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: 'call_1', name: 'write_file', args: {} },
                    thoughtSignature: 'opaque-sig'
                  }
                ]
              }
            }
          ]
        },
        { candidates: [{ finishReason: 'STOP' }] }
      ])
    )

    const provider = new GoogleProvider('key')
    const events = await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100 }))

    expect(events[0]).toEqual({
      type: 'tool_use_start',
      id: 'call_1',
      name: 'write_file',
      thoughtSignature: 'opaque-sig'
    })
  })

  it('echoes thoughtSignature back on the functionCall part when replaying a tool_use block', async () => {
    mockGenerateContentStream.mockResolvedValue(fakeStream([]))
    const provider = new GoogleProvider('key')
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'write_file', input: {}, thoughtSignature: 'opaque-sig' }
        ]
      }
    ]

    await collect(provider.stream({ model: 'gemini-flash-latest', messages, maxTokens: 100 }))

    const params = mockGenerateContentStream.mock.calls[0][0]
    expect(params.contents[0].parts[0].thoughtSignature).toBe('opaque-sig')
  })

  it('maps finishReason MAX_TOKENS to max_tokens', async () => {
    mockGenerateContentStream.mockResolvedValue(fakeStream([{ candidates: [{ finishReason: 'MAX_TOKENS' }] }]))
    const provider = new GoogleProvider('key')
    const events = await collect(provider.stream({ model: 'gemini-flash-latest', messages: [], maxTokens: 100 }))
    expect(events).toEqual([{ type: 'message_stop', stopReason: 'max_tokens' }])
  })

  it('maps the request: system instruction, tool_result -> functionResponse, assistant tool_use -> functionCall', async () => {
    mockGenerateContentStream.mockResolvedValue(fakeStream([]))
    const provider = new GoogleProvider('key')
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

    await collect(
      provider.stream({ model: 'gemini-flash-latest', system: 'be helpful', messages, maxTokens: 100 })
    )

    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1)
    const params = mockGenerateContentStream.mock.calls[0][0]
    expect(params.config.systemInstruction).toBe('be helpful')
    expect(params.contents).toEqual([
      { role: 'user', parts: [{ text: 'do it' }] },
      {
        role: 'model',
        parts: [{ text: 'ok' }, { functionCall: { id: 'call_1', name: 'write_file', args: { path: 'a.txt' } } }]
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: { id: 'call_1', name: 'write_file', response: { output: 'wrote it' } }
          }
        ]
      }
    ])
  })

  it('never sends a warning or image block back to the model — both are human-facing only (TASKS.md #82/#102)', async () => {
    mockGenerateContentStream.mockResolvedValue(fakeStream([]))
    const provider = new GoogleProvider('key')
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'show_media', input: { path: 'chart.png' } }] },
      {
        role: 'user',
        content: [
          { type: 'image', toolUseId: 'call_1', path: 'chart.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' },
          { type: 'tool_result', toolUseId: 'call_1', content: 'Displayed chart.png to the user.' }
        ]
      },
      { role: 'assistant', content: [{ type: 'warning', message: 'context trimmed' }] }
    ]

    await collect(provider.stream({ model: 'gemini-flash-latest', messages, maxTokens: 100 }))

    const params = mockGenerateContentStream.mock.calls[0][0]
    // The warning-only assistant message maps to an empty `parts` array
    // (there's no filter dropping the whole message the way OpenAI's/
    // Anthropic's mapping does — confirmed as existing behavior, not
    // something this change alters); the real point here is the image
    // block never appears anywhere in what's sent, under any key.
    expect(JSON.stringify(params.contents)).not.toContain('aGVsbG8=')
    expect(params.contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'call_1', name: 'show_media', response: { output: 'Displayed chart.png to the user.' } } }]
    })
  })

  it('wraps an error tool_result under the error key', async () => {
    mockGenerateContentStream.mockResolvedValue(fakeStream([]))
    const provider = new GoogleProvider('key')
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'x', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'boom', isError: true }]
      }
    ]

    await collect(provider.stream({ model: 'gemini-flash-latest', messages, maxTokens: 100 }))

    const params = mockGenerateContentStream.mock.calls[0][0]
    expect(params.contents[1].parts[0].functionResponse.response).toEqual({ error: 'boom' })
  })

  it('lists model ids, stripping the "models/" prefix', async () => {
    mockList.mockResolvedValue(fakeStream([{ name: 'models/gemini-flash-latest' }, { name: 'models/gemini-3.8-flash' }]))
    const provider = new GoogleProvider('key')
    expect(await provider.listModels()).toEqual(['gemini-flash-latest', 'gemini-3.8-flash'])
  })

  it('counts tokens via the real endpoint', async () => {
    mockCountTokens.mockResolvedValue({ totalTokens: 42 })
    const provider = new GoogleProvider('key')
    expect(await provider.countTokens([], 'gemini-flash-latest')).toBe(42)
  })
})

describe('GoogleProvider structured output', () => {
  it('sets responseMimeType and responseJsonSchema only when structuredOutput is requested', async () => {
    mockGenerateContentStream.mockReset()
    mockGenerateContentStream.mockImplementation(async () => fakeStream([{ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }]))
    const planSchema = { type: 'object', properties: { complexity: { type: 'string', enum: ['simple', 'compound'] } }, required: ['complexity'], additionalProperties: false }
    const provider = new GoogleProvider('key')
    const base = { model: 'gemini-3.5-flash', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], maxTokens: 10 }
    await collect(provider.stream(base))
    await collect(provider.stream({ ...base, structuredOutput: { name: 'classify_and_plan', schema: planSchema } }))
    const plain = mockGenerateContentStream.mock.calls[0][0].config
    const structured = mockGenerateContentStream.mock.calls[1][0].config
    expect(plain).not.toHaveProperty('responseMimeType')
    expect(structured.responseMimeType).toBe('application/json')
    expect(structured.responseJsonSchema).toEqual(planSchema)
  })
})
