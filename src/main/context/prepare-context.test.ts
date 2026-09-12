import { describe, expect, it } from 'vitest'
import type { Message, ModelProvider } from '../providers/types'
import { applySlidingWindow, prepareConversation, trimToolResults, type TurnOverhead } from './prepare-context'

const OVERHEAD_MARKER = 'SYS-PROMPT-MARKER'

/** Distinguishes the overhead-probe call (a single synthetic message carrying the marker) from a real history-count call, for a fakeProvider's countTokens callback. */
function isOverheadProbe(messages: Message[]): boolean {
  const block = messages[0]?.content[0]
  return messages.length === 1 && block?.type === 'text' && block.text.includes(OVERHEAD_MARKER)
}

function fakeProvider(
  countTokens: (messages: Message[]) => number,
  loadedContextWindow?: (model: string) => Promise<number | undefined>
): ModelProvider {
  return {
    id: 'fake',
    displayName: 'Fake',
    listModels: async () => [],
    stream: async function* () {},
    countTokens: async (messages) => countTokens(messages),
    loadedContextWindow
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

  it("budgets against a provider's own live context window over the static model-metadata estimate", async () => {
    // "gpt-oss:20b" is local-model-shaped, so model-metadata.ts's generic
    // fallback would give it 8192 tokens (budget 5734) — plenty of room for
    // a 6000-token turn. A live loadedContextWindow of 4096 (Ollama's real
    // runtime load, independent of the model's own larger architectural
    // max) drops the budget to 2867, which the oldest turn must be dropped
    // to fit under — reproducing, and fixing, the exact under-trimming bug
    // found live (a prompt that reached Ollama's true, smaller limit and
    // was silently truncated mid-turn with zero output).
    const messages = [userTurn('oldest'), userTurn('newest')]
    const provider = fakeProvider(
      (msgs) => msgs.length * 6000,
      async () => 4096
    )
    const result = await applySlidingWindow(messages, 'gpt-oss:20b', provider)
    expect(result).toEqual([userTurn('newest')])
  })

  it('falls back to the static estimate when the provider has no live figure (e.g. the model is not currently loaded)', async () => {
    const messages = [userTurn('oldest'), userTurn('newest')]
    // Both turns together cost 2000 tokens — comfortably under gpt-oss:20b's
    // static 4096*0.7=2867 fallback budget, so nothing gets dropped, unlike
    // the live-figure test above where an even smaller live reading forced
    // a drop. Confirms the fallback path itself runs (not just "some" budget).
    const provider = fakeProvider(
      (msgs) => msgs.length * 1000,
      async () => undefined
    )
    const result = await applySlidingWindow(messages, 'gpt-oss:20b', provider)
    expect(result).toEqual(messages)
  })

  describe('with a TurnOverhead (system prompt + tool schemas)', () => {
    const overhead: TurnOverhead = { system: OVERHEAD_MARKER, tools: [] }

    it('reserves the overhead\'s own token cost against the budget, forcing a trim that pure history-counting alone would not', async () => {
      // gpt-oss:20b's static fallback budget is floor(4096*0.7)=2867. Both
      // turns' real history costs 2000 — comfortably under 2867 on its own
      // (proven by the sibling "no overhead" case below) — but the system
      // prompt + tool schemas here cost 2000 too, leaving only 867 for
      // history, which forces the oldest turn to be dropped. This is the
      // exact gap found live: a 4096-token local model where the reserved
      // margin alone wasn't enough for this app's real system prompt plus
      // its ~15+ tool schemas plus a tool round-trip.
      const messages = [userTurn('oldest'), userTurn('newest')]
      const provider = fakeProvider((msgs) => (isOverheadProbe(msgs) ? 2000 : msgs.length * 1000))

      expect(await applySlidingWindow(messages, 'gpt-oss:20b', provider, overhead)).toEqual([userTurn('newest')])
      // Without the same overhead, the identical 2000-token history fits budget 2867 untrimmed.
      expect(await applySlidingWindow(messages, 'gpt-oss:20b', provider)).toEqual(messages)
    })

    it('clamps the reserved budget to zero (never negative) when the overhead alone exceeds it, still keeping the most recent turn', async () => {
      const messages = [userTurn('only turn')]
      const provider = fakeProvider((msgs) => (isOverheadProbe(msgs) ? 999_999 : 10))
      expect(await applySlidingWindow(messages, 'gpt-oss:20b', provider, overhead)).toEqual(messages)
    })

    it('prepareConversation threads the overhead through to applySlidingWindow', async () => {
      const messages = [userTurn('oldest'), userTurn('newest')]
      const provider = fakeProvider((msgs) => (isOverheadProbe(msgs) ? 2000 : msgs.length * 1000))
      const result = await prepareConversation(messages, 'gpt-oss:20b', provider, overhead)
      expect(result).toEqual([userTurn('newest')])
    })
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
