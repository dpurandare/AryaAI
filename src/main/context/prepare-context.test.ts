import { describe, expect, it } from 'vitest'
import { toOpenAIMessages } from '../providers/openai-compatible'
import type { ContentBlock } from '@shared/protocol'
import type { Message, ModelProvider } from '../providers/types'
import {
  applySlidingWindow,
  collapseFailedTurns,
  collapseUnavailableToolCalls,
  setAsideOtherSpecialistsReplies,
  migrateLegacyDelegateNames,
  normalizeUserNotesForWire,
  prepareConversation,
  repairToolPairs,
  splitIntoTurns,
  trimToolResults,
  type TurnOverhead
} from './prepare-context'

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

  // TASKS.md #148/#149: a listing-shaped tool (find_files/list_directory) gets a line-boundary cut and an
  // honest count, not a blind mid-line character cut — the whole point being the model can always tell exactly
  // how much of the listing it isn't seeing, rather than losing an arbitrarily-truncated last entry silently.
  it('trims a find_files result at a line boundary with a listing-shaped message, not a blind character cut', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `code/file-${String(i).padStart(3, '0')}.py`)
    const big = lines.join('\n')
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'find_files', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call-1', content: big }] }
    ]
    const [, trimmedMsg] = trimToolResults(messages)
    const block = trimmedMsg.content[0]
    expect(block.type).toBe('tool_result')
    if (block.type !== 'tool_result') throw new Error('unreachable')
    // Never cuts mid-line: every kept line before the marker is a complete, real entry from the original list.
    const [kept, marker] = block.content.split('\n...[')
    for (const line of kept.split('\n')) expect(lines).toContain(line)
    expect(marker).toContain('500 found, showing first')
    expect(marker).toContain('more not shown')
    expect(marker).not.toContain('characters omitted')
  })

  it('leaves a listing-shaped result under the cap untouched', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'list_directory', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call-1', content: 'file a.txt\nfile b.txt' }] }
    ]
    expect(trimToolResults(messages)).toEqual(messages)
  })
})

// TASKS.md #158: a mid-run steering comment must never fracture the turn it was injected into — these are
// the two mechanisms that make that true (splitIntoTurns treats it as a continuation; normalizeUserNotesForWire
// makes it read as ordinary text to the model without changing what's persisted/shown).
describe('splitIntoTurns treats a user_note as a continuation, not a new turn (#158)', () => {
  it('keeps a user_note-only message in the same turn as the assistant round it was injected into', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'original request' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'shell_execute', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'output' }] },
      { role: 'user', content: [{ type: 'user_note', text: 'wrong path, try the other table' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok, adjusting' }] }
    ]
    const turns = splitIntoTurns(messages)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toHaveLength(5)
  })

  it('an ordinary role:user text message still starts a genuinely new turn (the marker is not overbroad)', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first request' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second, unrelated request' }] }
    ]
    const turns = splitIntoTurns(messages)
    expect(turns).toHaveLength(2)
  })
})

describe('normalizeUserNotesForWire (#158)', () => {
  it('converts a user_note block to plain text, leaving everything else untouched', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'user_note', text: 'wrong path, try the other table' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } }] }
    ]
    const normalized = normalizeUserNotesForWire(messages)
    expect(normalized[1].content[0]).toEqual({ type: 'text', text: 'wrong path, try the other table' })
    expect(normalized[0]).toEqual(messages[0])
    expect(normalized[2]).toEqual(messages[2])
    // Original input untouched.
    expect(messages[1].content[0]).toEqual({ type: 'user_note', text: 'wrong path, try the other table' })
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

describe('repairToolPairs', () => {
  const use = (id: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'some_tool', input: {} }] })

  it('leaves a fully answered tool_use/tool_result exchange untouched', () => {
    const messages: Message[] = [
      userTurn('go'),
      use('c1'),
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    ]
    expect(repairToolPairs(messages)).toEqual(messages)
  })

  it('synthesizes an error tool_result for a tool_use left dangling by an abandoned stream, ahead of the next real user message', () => {
    const messages: Message[] = [userTurn('list them'), use('c1'), userTurn('hello?')]
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(4)
    expect(repaired[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'c1', isError: true }]
    })
    expect(repaired[3]).toEqual(userTurn('hello?'))
  })

  it('repairs a dangling tool_use at the very end of history', () => {
    const repaired = repairToolPairs([userTurn('go'), use('c1')])
    expect(repaired).toHaveLength(3)
    expect(repaired[2].content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'c1', isError: true })
  })

  it('fills in only the missing result when parallel calls were partially answered, merging into the existing result message', () => {
    const messages: Message[] = [
      userTurn('go'),
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 't', input: {} },
        { type: 'tool_use', id: 'b', name: 't', input: {} }
      ] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'ok' }] }
    ]
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(3)
    expect(repaired[2].content).toEqual([
      { type: 'tool_result', toolUseId: 'a', content: 'ok' },
      expect.objectContaining({ type: 'tool_result', toolUseId: 'b', isError: true })
    ])
  })

  it('does not mutate its input', () => {
    const messages: Message[] = [userTurn('go'), use('c1')]
    repairToolPairs(messages)
    expect(messages).toHaveLength(2)
  })

  it('keeps the synthesized result in the same turn, so the sliding window never separates the pair', async () => {
    const messages: Message[] = [userTurn('old'), use('c1'), userTurn('new')]
    const { messages: sent } = await prepareConversation(messages, 'gpt-4', fakeProvider(() => 0))
    const useIdx = sent.findIndex((m) => m.content.some((b) => b.type === 'tool_use'))
    expect(sent[useIdx + 1].content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'c1' })
  })
})

describe('repairToolPairs — nested delegate replay and orphan results', () => {
  /** OpenAI-compatible pairing rule, checked on the real wire format: a tool message must directly follow an assistant tool_calls message that names its id, and every tool_call needs a tool message in the run right after it. Returns every violation. */
  function wireViolations(messages: Message[]): string[] {
    const wire = toOpenAIMessages(undefined, messages) as { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[]
    const out: string[] = []
    wire.forEach((m, i) => {
      if (m.role === 'tool') {
        let j = i - 1
        while (j >= 0 && wire[j].role === 'tool') j--
        if (!wire[j]?.tool_calls?.some((t) => t.id === m.tool_call_id)) out.push(`orphan tool result ${m.tool_call_id}`)
      } else if (m.role === 'assistant' && m.tool_calls) {
        const answered = new Set<string>()
        for (let j = i + 1; j < wire.length && wire[j].role === 'tool'; j++) answered.add(wire[j].tool_call_id ?? '')
        for (const t of m.tool_calls) if (!answered.has(t.id)) out.push(`unanswered tool_call ${t.id}`)
      }
    })
    return out
  }

  const callDelegate = (id: string, role?: 'coding' | 'terminal-devops'): Message => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'delegate_to_coding', input: { task: 't' }, agentRole: role }]
  })
  const result = (id: string, content = 'ok'): Message => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content }] })

  // The exact shape found live in the session "How many customers are there in northwind database?" — the specialist's messages sit between the delegate call and its result.
  const nestedDelegate = (): Message[] => [
    userTurn('build charts'),
    callDelegate('D1'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'W1', name: 'write_file', input: {}, agentRole: 'coding' }] },
    result('W1', 'wrote it'),
    { role: 'assistant', content: [{ type: 'text', text: 'I created create_charts.py', agentRole: 'coding' }] },
    result('D1', 'I created create_charts.py'),
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  ]

  it('reproduces the real failure: the raw stored history is wire-invalid', () => {
    expect(wireViolations(nestedDelegate())).toEqual(['unanswered tool_call D1', 'orphan tool result D1'])
  })

  it('drops the specialist\'s nested messages so the delegate result directly follows its call', () => {
    const repaired = repairToolPairs(nestedDelegate())
    expect(repaired).toEqual([
      userTurn('build charts'),
      callDelegate('D1'),
      result('D1', 'I created create_charts.py'),
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
    ])
    expect(wireViolations(repaired)).toEqual([])
  })

  it('handles a delegate that itself delegates (two levels of nesting)', () => {
    const messages: Message[] = [
      userTurn('go'),
      callDelegate('D1'),
      callDelegate('D2', 'coding'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'S1', name: 'shell_execute', input: {}, agentRole: 'terminal-devops' }] },
      result('S1'),
      { role: 'assistant', content: [{ type: 'text', text: 'ran it', agentRole: 'terminal-devops' }] },
      result('D2'),
      { role: 'assistant', content: [{ type: 'text', text: 'coding done', agentRole: 'coding' }] },
      result('D1')
    ]
    const repaired = repairToolPairs(messages)
    expect(repaired).toEqual([userTurn('go'), callDelegate('D1'), result('D1')])
    expect(wireViolations(repaired)).toEqual([])
  })

  it('handles a delegate called in parallel with an ordinary tool, answered together in one result message', () => {
    const messages: Message[] = [
      userTurn('go'),
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'D1', name: 'delegate_to_coding', input: {} },
        { type: 'tool_use', id: 'R1', name: 'read_file', input: {} }
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'nested', agentRole: 'coding' }] },
      { role: 'user', content: [
        { type: 'tool_result', toolUseId: 'D1', content: 'delegate done' },
        { type: 'tool_result', toolUseId: 'R1', content: 'file text' }
      ] }
    ]
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(3)
    expect(wireViolations(repaired)).toEqual([])
  })

  it('handles several sequential delegations in one history', () => {
    const one = nestedDelegate().slice(1, 6)
    const repaired = repairToolPairs([userTurn('a'), ...one, userTurn('b'), ...one.map((m) => JSON.parse(JSON.stringify(m).replace(/D1/g, 'D9').replace(/W1/g, 'W9')) as Message)])
    expect(wireViolations(repaired)).toEqual([])
    expect(repaired.filter((m) => m.content.some((b) => b.type === 'tool_use' && b.name === 'write_file'))).toHaveLength(0)
  })

  it('falls back to a wire-valid history when the gap is NOT provably nested (no agentRole markers, e.g. sessions saved before they existed)', () => {
    const untagged: Message[] = [
      userTurn('go'),
      callDelegate('D1'),
      { role: 'assistant', content: [{ type: 'text', text: 'something' }] },
      result('D1')
    ]
    const repaired = repairToolPairs(untagged)
    expect(wireViolations(repaired)).toEqual([])
    // Nothing that could be real content was dropped: the assistant text survives.
    expect(repaired.some((m) => m.content.some((b) => b.type === 'text' && b.text === 'something'))).toBe(true)
  })

  it('never removes across a real user message — a delegate cannot span a turn boundary', () => {
    const messages: Message[] = [userTurn('a'), callDelegate('D1'), userTurn('b'), { role: 'assistant', content: [{ type: 'text', text: 'hi', agentRole: 'coding' }] }, result('D1')]
    const repaired = repairToolPairs(messages)
    expect(wireViolations(repaired)).toEqual([])
    expect(repaired.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === 'b'))).toBe(true)
  })

  it('drops an orphan tool_result that answers nothing, and the message if that leaves it empty', () => {
    const messages: Message[] = [userTurn('go'), { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, result('GHOST'), userTurn('next')]
    const repaired = repairToolPairs(messages)
    expect(repaired).toEqual([userTurn('go'), { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, userTurn('next')])
  })

  it('keeps the valid results in a message and drops only the orphan one', () => {
    const messages: Message[] = [
      userTurn('go'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'A', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'A', content: 'ok' }, { type: 'tool_result', toolUseId: 'GHOST', content: 'x' }] }
    ]
    const repaired = repairToolPairs(messages)
    expect(repaired[2].content).toEqual([{ type: 'tool_result', toolUseId: 'A', content: 'ok' }])
  })

  it('is idempotent — repairing an already-repaired history changes nothing', () => {
    const once = repairToolPairs(nestedDelegate())
    expect(repairToolPairs(once)).toEqual(once)
  })

  it('does not mutate its input', () => {
    const messages = nestedDelegate()
    const snapshot = JSON.stringify(messages)
    repairToolPairs(messages)
    expect(JSON.stringify(messages)).toBe(snapshot)
  })
})

describe('prepareConversation', () => {
  it('trims tool results and applies the sliding window together', async () => {
    const big = 'y'.repeat(5000)
    const messages: Message[] = [
      userTurn('old'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: big }] },
      userTurn('new')
    ]
    const provider = fakeProvider(() => 0) // always under budget -> only trimming should apply
    const result = await prepareConversation(messages, 'claude-sonnet-5', provider)
    expect(result.messages).toHaveLength(4)
    expect(result.droppedTurns).toEqual([])
    const toolResult = result.messages[2].content[0]
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

describe('migrateLegacyDelegateNames', () => {
  const call = (name: string, id = 'D1'): Message => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: { task: 't' }, agentRole: 'terminal-devops' }]
  })

  it('renames the delegate tools of retired roles (Terminal/DevOps, Distribution) to the Developer on replay', () => {
    const out = migrateLegacyDelegateNames([call('delegate_to_terminal_devops', 'A'), call('delegate_to_distribution', 'B')])
    expect(out.flatMap((m) => m.content).map((b) => (b.type === 'tool_use' ? b.name : ''))).toEqual(['delegate_to_coding', 'delegate_to_coding'])
  })

  it('keeps the tool_use id (so the paired tool_result still matches) and the agentRole tag (so the UI chip is unchanged)', () => {
    const block = migrateLegacyDelegateNames([call('delegate_to_terminal_devops', 'KEEP')])[0].content[0]
    expect(block).toMatchObject({ type: 'tool_use', id: 'KEEP', agentRole: 'terminal-devops', name: 'delegate_to_coding' })
  })

  it('leaves current delegates and ordinary tools alone, and returns the same array when nothing changes', () => {
    const messages: Message[] = [call('delegate_to_data'), call('shell_execute'), call('delegate_to_coding')]
    expect(migrateLegacyDelegateNames(messages)).toBe(messages)
  })

  it('does not mutate its input (the stored transcript must stay as recorded)', () => {
    const messages: Message[] = [call('delegate_to_terminal_devops')]
    migrateLegacyDelegateNames(messages)
    expect(messages[0].content[0]).toMatchObject({ name: 'delegate_to_terminal_devops' })
  })
})

describe('collapseUnavailableToolCalls (slim router: no provider is shown a call to a tool it was not given)', () => {
  const call = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({ type: 'tool_use', id, name, input })
  const result = (id: string, content: string, isError = false): ContentBlock => ({ type: 'tool_result', toolUseId: id, content, isError })
  const available = new Set(['shell_execute', 'delegate_to_data'])

  it('returns the SAME array when every call is to an available tool', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [call('a', 'shell_execute', { command: 'ls' })] },
      { role: 'user', content: [result('a', 'ok')] }
    ]
    expect(collapseUnavailableToolCalls(messages, available)).toBe(messages)
  })

  it('turns a call to an unavailable tool AND its result into text, so no tool_use/tool_result for it remains', () => {
    const out = collapseUnavailableToolCalls(
      [
        { role: 'assistant', content: [call('x', 'xlsx_write', { path: 'a.xlsx' })] },
        { role: 'user', content: [result('x', 'Wrote 3 rows.')] }
      ],
      available
    )
    expect(out[0].content).toEqual([{ type: 'text', text: '[earlier: called xlsx_write({"path":"a.xlsx"})]' }])
    expect(out[1].content).toEqual([{ type: 'text', text: '[earlier result of xlsx_write: Wrote 3 rows.]' }])
    expect(out.flatMap((m) => m.content).some((b) => b.type === 'tool_use' || b.type === 'tool_result')).toBe(false)
  })

  it('a mixed turn keeps the available call paired and puts converted results AFTER the real tool_result (Anthropic wants tool_results first)', () => {
    const out = collapseUnavailableToolCalls(
      [
        { role: 'assistant', content: [{ type: 'text', text: 'Doing two things.' }, call('gone', 'xlsx_write'), call('kept', 'shell_execute', { command: 'ls' })] },
        { role: 'user', content: [result('gone', 'done'), result('kept', 'files')] }
      ],
      available
    )
    expect(out[0].content.map((b) => b.type)).toEqual(['text', 'text', 'tool_use']) // order preserved, only the absent call converted
    expect(out[0].content[2]).toMatchObject({ type: 'tool_use', id: 'kept', name: 'shell_execute' })
    expect(out[1].content.map((b) => b.type)).toEqual(['tool_result', 'text'])
    expect(out[1].content[0]).toMatchObject({ toolUseId: 'kept' })
  })

  it('keeps the wire-format invariant the providers enforce: every remaining tool_use has its tool_result and vice versa', () => {
    const out = collapseUnavailableToolCalls(
      [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [call('1', 'db_execute_sql'), call('2', 'shell_execute')] },
        { role: 'user', content: [result('1', 'rows'), result('2', 'ok')] },
        { role: 'assistant', content: [call('3', 'delegate_to_data')] },
        { role: 'user', content: [result('3', 'x')] }
      ],
      available
    )
    const uses = out.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])))
    const results = out.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : [])))
    expect(uses.sort()).toEqual(['2', '3'])
    expect(results.sort()).toEqual(['2', '3'])
  })

  it('marks an errored result, truncates long ones, and shortens a long input', () => {
    const out = collapseUnavailableToolCalls(
      [
        { role: 'assistant', content: [call('e', 'api_call', { body: 'x'.repeat(400) })] },
        { role: 'user', content: [result('e', 'y'.repeat(900), true)] }
      ],
      available
    )
    const callText = (out[0].content[0] as { text: string }).text
    const resText = (out[1].content[0] as { text: string }).text
    expect(callText.length).toBeLessThan(220)
    expect(callText).toContain('…')
    expect(resText).toMatch(/^\[earlier result of api_call \(error\): y{500}…\]$/)
  })

  it('preserves the agentRole tag on a converted call (the UI chip and nested-message repair key on it) and does not mutate its input', () => {
    const messages: Message[] = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'n', name: 'xlsx_write', input: {}, agentRole: 'coding' }] }]
    const out = collapseUnavailableToolCalls(messages, available)
    expect(out[0].content[0]).toMatchObject({ type: 'text', agentRole: 'coding' })
    expect(messages[0].content[0]).toMatchObject({ type: 'tool_use', name: 'xlsx_write' })
  })
})

describe('setAsideOtherSpecialistsReplies (found live in 11.6: a pinned specialist answered as another one)', () => {
  const label = (role: string): string => ({ planning: 'Planner', research: 'Researcher' })[role] ?? role
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi, I am Sachivji.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi, I plan.', agentRole: 'planning' }] },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi, I research.', agentRole: 'research' }] },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
  ]

  it("takes other specialists' and Auto's earlier text out of the conversation and hands it back as background, keeping the current role's own", () => {
    const { messages, background } = setAsideOtherSpecialistsReplies(history, 'research', label)
    const texts = messages.map((m) => (m.content[0] as { text: string }).text)
    expect(texts).toEqual(['Hello', 'Hello', 'Hello', 'Hi, I research.', 'Hello'])
    expect(background).toContain('- Sachivji (Auto): Hi, I am Sachivji.')
    expect(background).toContain('- Planner: Hi, I plan.')
    expect(background).not.toContain('Hi, I research.')
    expect(background).toContain('you are the Researcher specialist')
  })

  it('does the same for Auto: replies written by pinned specialists become background, the router\'s own (untagged) replies stay', () => {
    const { messages, background } = setAsideOtherSpecialistsReplies(history, undefined, label)
    expect(messages.map((m) => (m.content[0] as { text: string }).text)).toEqual(['Hello', 'Hi, I am Sachivji.', 'Hello', 'Hello', 'Hello'])
    expect(background).toContain('- Planner: Hi, I plan.')
    expect(background).toContain('- Researcher: Hi, I research.')
    expect(background).not.toContain('Hi, I am Sachivji.')
    expect(background).toContain('you are Sachivji, the orchestrator')
  })

  it('leaves tool calls, the current turn and the stored conversation alone, and gives no background when nothing was set aside', () => {
    const turn: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: 'c1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }] }
    ]
    const out = setAsideOtherSpecialistsReplies(turn, 'research', label)
    expect(out.messages).toEqual(turn)
    expect(out.background).toBe('')
    expect((history[3].content[0] as { text: string }).text).toBe('Hi, I plan.')
  })
})
