import { describe, expect, it } from 'vitest'
import type { Message, ModelProvider } from '../providers/types'
import { applySlidingWindow, prepareConversation, trimToolResults } from './prepare-context'

function fakeProvider(countTokens: (messages: Message[]) => number): ModelProvider {
  return {
    id: 'fake',
    displayName: 'Fake',
    listModels: async () => [],
    stream: async function* () {},
    countTokens: async (messages) => countTokens(messages)
  }
}

function userTurn(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

describe('trimToolResults', () => {
  it('leaves a short tool_result untouched', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'short result' }] }
    ]
    expect(trimToolResults(messages)).toEqual(messages)
  })

  it('caps an oversized tool_result with a clear truncation marker, leaving the input untouched', () => {
    const big = 'x'.repeat(5000)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: big }] }
    ]
    const [trimmed] = trimToolResults(messages)
    const block = trimmed.content[0]
    expect(block.type).toBe('tool_result')
    if (block.type !== 'tool_result') throw new Error('unreachable')
    expect(block.content.length).toBeLessThan(big.length)
    expect(block.content).toContain('truncated, 1000 characters omitted')
    // Original input array/object is not mutated.
    expect((messages[0].content[0] as { content: string }).content).toBe(big)
  })

  it('leaves non-tool_result blocks untouched', () => {
    const messages: Message[] = [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]
    expect(trimToolResults(messages)).toEqual(messages)
  })
})

describe('applySlidingWindow', () => {
  it('keeps everything when already under budget', async () => {
    const messages = [userTurn('one'), userTurn('two')]
    const provider = fakeProvider(() => 10)
    expect(await applySlidingWindow(messages, 'claude-sonnet-5', provider)).toEqual(messages)
  })

  it('drops the oldest complete turns first when over budget', async () => {
    const messages = [userTurn('oldest'), userTurn('middle'), userTurn('newest')]
    // Pretend every turn costs 100k tokens; claude-sonnet-5's window (200k) * 0.7 budget = 140k,
    // so only the single most recent turn should survive.
    const provider = fakeProvider((msgs) => msgs.length * 100_000)
    const result = await applySlidingWindow(messages, 'claude-sonnet-5', provider)
    expect(result).toEqual([userTurn('newest')])
  })

  it('never drops a tool_use/tool_result pair mid-turn', async () => {
    const oldTurn: Message[] = [
      userTurn('old task'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: {} }]
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'done' }] }
    ]
    const newTurn = [userTurn('new task')]
    const messages = [...oldTurn, ...newTurn]

    // Force exactly one drop.
    let calls = 0
    const provider = fakeProvider(() => {
      calls++
      return calls === 1 ? 999_999 : 0
    })
    const result = await applySlidingWindow(messages, 'claude-sonnet-5', provider)
    expect(result).toEqual(newTurn)
    // No leftover tool_result with no preceding tool_use.
    expect(result.some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(false)
  })

  it('always keeps at least the most recent turn even if it alone is over budget', async () => {
    const messages = [userTurn('only turn, huge')]
    const provider = fakeProvider(() => 999_999_999)
    expect(await applySlidingWindow(messages, 'claude-sonnet-5', provider)).toEqual(messages)
  })
})

describe('prepareConversation', () => {
  it('trims tool results and applies the sliding window together', async () => {
    const big = 'y'.repeat(5000)
    const messages: Message[] = [
      userTurn('old'),
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: big }] },
      userTurn('new')
    ]
    const provider = fakeProvider(() => 0) // always under budget -> only trimming should apply
    const result = await prepareConversation(messages, 'claude-sonnet-5', provider)
    expect(result).toHaveLength(3)
    const toolResult = result[1].content[0]
    expect(toolResult.type).toBe('tool_result')
    if (toolResult.type !== 'tool_result') throw new Error('unreachable')
    expect(toolResult.content.length).toBeLessThan(big.length)
  })
})
