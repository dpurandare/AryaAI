import { describe, expect, it } from 'vitest'
import type { Message, ModelProvider } from '../providers/types'
import { applySlidingWindow, collapseFailedTurns, prepareConversation, trimToolResults, type TurnOverhead } from './prepare-context'

const OVERHEAD_MARKER = 'SYS-PROMPT-MARKER'

/** Distinguishes the overhead-probe call (a single synthetic message carrying the marker) from a real history-count call, for a fakeProvider's countTokens callback. */
function isOverheadProbe(messages: Message[]): boolean {
  const block = messages[0]?.content[0]
  return messages.length === 1 && block?.type === 'text' && block.text.includes(OVERHEAD_MARKER)
}

function fakeProvider(
  countTokens: (messages: Message[]) => number,
  loadedContextWindow?: (model: string) => Promise<number | undefined>,
  configuredContextWindow?: (model: string) => Promise<number | undefined>
): ModelProvider {
  return {
    id: 'fake',
    displayName: 'Fake',
    listModels: async () => [],
    stream: async function* () {},
    countTokens: async (messages) => countTokens(messages),
    loadedContextWindow,
    configuredContextWindow
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
  it('keeps everything when already under budget, reporting nothing dropped', async () => {
    const messages = [userTurn('one'), userTurn('two')]
    const provider = fakeProvider(() => 10)
    const result = await applySlidingWindow(messages, 'claude-sonnet-5', provider)
    expect(result.messages).toEqual(messages)
    expect(result.droppedTurns).toEqual([])
  })

  it('drops the oldest complete turns first when over budget, reporting exactly what was dropped', async () => {
    const messages = [userTurn('oldest'), userTurn('middle'), userTurn('newest')]
    // Pretend every turn costs 100k tokens; claude-sonnet-5's window (200k) * 0.7 budget = 140k,
    // so only the single most recent turn should survive.
    const provider = fakeProvider((msgs) => msgs.length * 100_000)
    const result = await applySlidingWindow(messages, 'claude-sonnet-5', provider)
    expect(result.messages).toEqual([userTurn('newest')])
    // Reported oldest-first, as real content (not just a count) — see
    // SlidingWindowResult's doc comment: a future summarization pass needs
    // the actual dropped turns, not just to know how many there were.
    expect(result.droppedTurns).toEqual([[userTurn('oldest')], [userTurn('middle')]])
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
    expect(result.messages).toEqual(newTurn)
    expect(result.droppedTurns).toEqual([oldTurn])
    // No leftover tool_result with no preceding tool_use.
    expect(result.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(false)
  })

  it('always keeps at least the most recent turn even if it alone is over budget', async () => {
    const messages = [userTurn('only turn, huge')]
    const provider = fakeProvider(() => 999_999_999)
    const result = await applySlidingWindow(messages, 'claude-sonnet-5', provider)
    expect(result.messages).toEqual(messages)
    expect(result.droppedTurns).toEqual([])
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
    expect(result.messages).toEqual([userTurn('newest')])
    // A live reading is a real, confirmed number — never itself an "estimate",
    // regardless of how it compares to the model's own static fallback.
    expect(result.contextWindow).toEqual({ tokens: 4096, isEstimate: false })
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
    expect(result.messages).toEqual(messages)
    expect(result.contextWindow).toEqual({ tokens: 4096, isEstimate: true })
  })

  it("prefers a live reading over a configured one when both are available", async () => {
    const messages = [userTurn('only turn')]
    const provider = fakeProvider(
      () => 10,
      async () => 4096, // live: model is loaded at a smaller runtime context than configured
      async () => 131072 // configured: the Modelfile's own declared num_ctx
    )
    const result = await applySlidingWindow(messages, 'gpt-oss-custom:latest', provider)
    expect(result.contextWindow).toEqual({ tokens: 4096, isEstimate: false })
  })

  it("falls back to a configured (Modelfile num_ctx) reading when there is no live one — the common case of a model idled cold between messages", async () => {
    const messages = [userTurn('only turn')]
    const provider = fakeProvider(
      () => 10,
      async () => undefined, // cold — Ollama's default idle-unload behavior
      async () => 131072
    )
    const result = await applySlidingWindow(messages, 'gpt-oss-custom:latest', provider)
    // A configured reading is a real, confirmed number — never itself an "estimate".
    expect(result.contextWindow).toEqual({ tokens: 131072, isEstimate: false })
  })

  it("reports a matched static cloud-model entry as a real number, not an estimate, when the provider has no live reading at all", async () => {
    const messages = [userTurn('only turn')]
    // claude-* has no loadedContextWindow on any real provider adapter —
    // this exercises the same "no live reading" path as the local-model
    // fallback test above, but against a recognized cloud model id, where
    // the static table entry itself is a real, not-a-guess number.
    const provider = fakeProvider((msgs) => msgs.length * 10)
    const result = await applySlidingWindow(messages, 'claude-sonnet-5', provider)
    expect(result.contextWindow).toEqual({ tokens: 200_000, isEstimate: false })
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

      const trimmed = await applySlidingWindow(messages, 'gpt-oss:20b', provider, overhead)
      expect(trimmed.messages).toEqual([userTurn('newest')])
      // Without the same overhead, the identical 2000-token history fits budget 2867 untrimmed.
      const untrimmed = await applySlidingWindow(messages, 'gpt-oss:20b', provider)
      expect(untrimmed.messages).toEqual(messages)
    })

    it('clamps the reserved budget to zero (never negative) when the overhead alone exceeds it, still keeping the most recent turn', async () => {
      const messages = [userTurn('only turn')]
      const provider = fakeProvider((msgs) => (isOverheadProbe(msgs) ? 999_999 : 10))
      const result = await applySlidingWindow(messages, 'gpt-oss:20b', provider, overhead)
      expect(result.messages).toEqual(messages)
    })

    it('prepareConversation threads the overhead through to applySlidingWindow', async () => {
      const messages = [userTurn('oldest'), userTurn('newest')]
      const provider = fakeProvider((msgs) => (isOverheadProbe(msgs) ? 2000 : msgs.length * 1000))
      const result = await prepareConversation(messages, 'gpt-oss:20b', provider, overhead)
      expect(result.messages).toEqual([userTurn('newest')])
    })
  })
})

function failedTurn(question: string, category: 'communication_failure' | 'stopped_by_user' | 'no_answer', reason: string): Message[] {
  return [userTurn(question), { role: 'assistant', content: [{ type: 'warning', message: reason, failureCategory: category }] }]
}

function answeredTurn(question: string, answer: string): Message[] {
  return [userTurn(question), { role: 'assistant', content: [{ type: 'text', text: answer }] }]
}

describe('collapseFailedTurns (TASKS.md #102)', () => {
  it('leaves an ordinary answered turn untouched', () => {
    const turn = answeredTurn('hi', 'hello!')
    expect(collapseFailedTurns(turn)).toEqual(turn)
  })

  it('leaves an ordinary informational warning (no failureCategory) untouched — e.g. a context-trim notice on a turn that still has a real answer', () => {
    const turn: Message[] = [
      userTurn('hi'),
      {
        role: 'assistant',
        content: [
          { type: 'warning', message: 'This conversation has grown long enough...' },
          { type: 'text', text: 'hello!' }
        ]
      }
    ]
    expect(collapseFailedTurns(turn)).toEqual(turn)
  })

  it('converts an isolated failed turn into real, model-visible text instead of a warning block', () => {
    // A plain `warning` block is stripped from the wire format entirely by
    // every provider adapter — this must become real `text` content for a
    // deliberately-kept single failure to actually reach the model.
    const turn = failedTurn('Tell me about Electron.', 'communication_failure', 'Rate limit exceeded.')
    const result = collapseFailedTurns(turn)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(userTurn('Tell me about Electron.'))
    expect(result[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '[Previous attempt failed — Rate limit exceeded.]' }]
    })
  })

  it('collapses a run of 2+ consecutive failed turns into one synthetic turn, not N near-identical resends', () => {
    // Reproduces the real bug: the same question retried 4 times in a row,
    // each attempt failing outright.
    const messages = [
      ...failedTurn('Tell me about Electron.', 'communication_failure', 'Rate limit exceeded.'),
      ...failedTurn('Tell me about Electron.', 'no_answer', 'The model produced no visible output.'),
      ...failedTurn('Tell me about Electron.', 'stopped_by_user', 'This request was stopped before producing a response. No answer was given.'),
      ...failedTurn('Tell me about Electron.', 'communication_failure', 'Service unavailable.')
    ]
    const result = collapseFailedTurns(messages)
    expect(result).toHaveLength(2) // one synthetic turn, not 8 messages
    expect(result[0]).toEqual(userTurn('Tell me about Electron.'))
    expect(result[1]).toMatchObject({ role: 'assistant' })
    const text = result[1].content[0]
    expect(text.type).toBe('text')
    if (text.type !== 'text') throw new Error('unreachable')
    expect(text.text).toContain('attempted 4 times in a row')
    expect(text.text).toContain('Service unavailable.') // most recent reason, not the first
  })

  it('does not collapse across a successful turn in between — two separate isolated failures, not one run', () => {
    const messages = [
      ...failedTurn('Tell me about Electron.', 'communication_failure', 'Rate limit exceeded.'),
      ...answeredTurn('What is Node.js?', 'Node.js is a JavaScript runtime.'),
      ...failedTurn('Tell me about Electron.', 'no_answer', 'The model produced no visible output.')
    ]
    const result = collapseFailedTurns(messages)
    // Each isolated failure converted individually (2 turns), the real
    // answer preserved untouched in between (1 turn) = 3 turns, 6 messages.
    expect(result).toHaveLength(6)
    expect(result[2]).toEqual(userTurn('What is Node.js?'))
    expect(result[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Node.js is a JavaScript runtime.' }] })
  })

  it('a turn with real partial text alongside a warning is never treated as a failed turn, even with max_tokens-style wording', () => {
    // Mirrors orchestrator.ts's own rule: failureCategory is only ever set
    // when there is no real text/tool_use at all — a cut-off-but-partially-
    // useful response must stay exactly as normal kept-in-context content.
    const turn: Message[] = [
      userTurn('Summarize this long document.'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is a partial summary before being cut off...' },
          { type: 'warning', message: 'This response was cut off after reaching the token limit.' }
        ]
      }
    ]
    expect(collapseFailedTurns(turn)).toEqual(turn)
  })

  it('a real tool_use/tool_result exchange in a turn is never treated as failed, even if a warning is also present', () => {
    const turn: Message[] = [
      userTurn('write a file'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'done' }] }
    ]
    expect(collapseFailedTurns(turn)).toEqual(turn)
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
    expect(result.messages).toHaveLength(3)
    expect(result.droppedTurns).toEqual([])
    const toolResult = result.messages[1].content[0]
    expect(toolResult.type).toBe('tool_result')
    if (toolResult.type !== 'tool_result') throw new Error('unreachable')
    expect(toolResult.content.length).toBeLessThan(big.length)
  })

  it('collapses repeated failed retries before sending, reproducing the real bug live-verified against Groq (TASKS.md #102)', async () => {
    // The exact real-world shape: the same question sent 4 times in a row,
    // each attempt failing, before a 5th attempt (the current one, not yet
    // in `messages`) finally succeeds.
    const messages = [
      ...failedTurn('Tell me about Electron application development framework.', 'communication_failure', 'Rate limit exceeded.'),
      ...failedTurn('Tell me about Electron application development framework.', 'no_answer', 'The model produced no visible output.'),
      ...failedTurn('Tell me about Electron application development framework.', 'stopped_by_user', 'This request was stopped before producing a response. No answer was given.'),
      ...failedTurn('Tell me about Electron application development framework.', 'communication_failure', 'Rate limit exceeded.')
    ]
    const provider = fakeProvider(() => 10) // comfortably under budget either way — isolates collapseFailedTurns' own effect
    const result = await prepareConversation(messages, 'claude-sonnet-5', provider)

    expect(result.messages).toHaveLength(2) // one synthetic turn, not 4 (8 messages)
    const summary = result.messages[1].content[0]
    expect(summary.type).toBe('text')
    if (summary.type !== 'text') throw new Error('unreachable')
    expect(summary.text).toContain('attempted 4 times in a row')
  })
})
