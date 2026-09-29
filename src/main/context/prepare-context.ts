import { contextWindowFor, type ContextWindowInfo } from '@shared/model-metadata'
import type { ContentBlock, Message, ModelProvider } from '../providers/types'

const TOOL_RESULT_MAX_CHARS = 4000
/** Leaves headroom under the model's real limit for the response itself and further tool round-trips within the same turn — the system prompt and tool schemas are now measured directly (see `TurnOverhead`/`overheadTokens` below) rather than assumed to fit inside this fraction. Exported so `orchestrator.ts`'s mid-turn re-fit (TASKS.md #98) budgets against the exact same fraction as this pre-turn trim, rather than a second, potentially-inconsistent margin. */
export const CONTEXT_BUDGET_FRACTION = 0.7

/**
 * The system prompt and full tool-schema list actually sent alongside the
 * message history — real, measurable overhead that used to be silently
 * assumed to fit inside CONTEXT_BUDGET_FRACTION's reserved margin. That
 * assumption holds for a 100K+-token cloud window but not for a small local
 * one: confirmed live, a 4096-token Ollama model's ~1229-token margin
 * wasn't enough for this app's own system prompt plus its ~15+ registered
 * tool schemas plus one search_history round-trip, so the *history* trim
 * being otherwise correct still weren't enough to avoid the server
 * truncating the prompt mid-turn with zero visible output.
 */
export interface TurnOverhead {
  system: string
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
}

/**
 * Approximates the overhead's token cost via the same `provider.countTokens`
 * used for the real message history — not a separate estimator, so it stays
 * consistent with whatever counting method (a real API call for
 * Anthropic/Google, a local approximation for OpenAI/Ollama) that provider
 * already uses. `countTokens` only accepts `Message[]`, not a system string,
 * so the overhead text rides along as a single synthetic user message —
 * never sent to the model, just counted.
 */
export async function overheadTokens(overhead: TurnOverhead, model: string, provider: ModelProvider): Promise<number> {
  const text = `${overhead.system}\n${JSON.stringify(overhead.tools)}`
  return provider.countTokens([{ role: 'user', content: [{ type: 'text', text }] }], model)
}

/** Tools whose result is one entry per line (a file/directory listing) — TASKS.md #148: a blind character cut mid-line is
 * both uglier and less useful than cutting at a line boundary with an honest "N found, showing first K" count.
 * Exported for reuse by orchestrator.ts's `capRepeatedToolResults` (#149), which needs the same "this is a listing"
 * knowledge to collapse an older result compactly instead of erasing it. */
export const LISTING_TOOL_NAMES = new Set(['list_directory', 'find_files'])

/** `toolUseId` -> the tool name that produced it, built once from every `tool_use` block across the whole array — a
 * `tool_result` only carries the id (`shared/protocol.ts`), never the name, so this is the only way to know which tool a
 * given result came from without re-plumbing the name onto `tool_result` itself. */
function toolNamesByUseId(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name)
    }
  }
  return names
}

/** Cuts `content` at the last full line within the budget rather than mid-line, and reports a listing-shaped count
 * ("N found, showing first K") instead of a raw character count — TASKS.md #148/#149's shared "compact but complete,
 * never silently lossy" principle: the model should know exactly how much it isn't seeing and how to see the rest. */
function trimListingResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content
  const lines = content.split('\n')
  let kept = 0
  let usedChars = 0
  for (const line of lines) {
    const lineChars = line.length + 1 // +1 for the newline this line re-adds when joined back
    if (usedChars + lineChars > TOOL_RESULT_MAX_CHARS && kept > 0) break
    usedChars += lineChars
    kept++
  }
  const omitted = lines.length - kept
  return `${lines.slice(0, kept).join('\n')}\n...[${lines.length} found, showing first ${kept} — narrow the pattern/path or use write_file to persist the full list, ${omitted} more not shown]`
}

/**
 * Caps any oversized tool_result content before it's sent to the provider —
 * a large file read or `git log` can otherwise balloon a request by itself.
 * Only affects what's sent; the full result stays in SQLite and the UI
 * transcript untouched, so nothing the user can see is ever silently cut.
 */
export function trimToolResults(messages: Message[]): Message[] {
  const toolNames = toolNamesByUseId(messages)
  return messages.map((m) => ({
    ...m,
    content: m.content.map((block): ContentBlock => {
      if (block.type !== 'tool_result' || block.content.length <= TOOL_RESULT_MAX_CHARS) return block
      if (LISTING_TOOL_NAMES.has(toolNames.get(block.toolUseId) ?? '')) {
        return { ...block, content: trimListingResult(block.content) }
      }
      const omitted = block.content.length - TOOL_RESULT_MAX_CHARS
      return {
        ...block,
        content: `${block.content.slice(0, TOOL_RESULT_MAX_CHARS)}\n...[truncated, ${omitted} characters omitted]`
      }
    })
  }))
}

/** A message made only of tool_result/image/user_note blocks is the continuation of the turn before it, not a new one
 * — same convention already used by the renderer (App.svelte's mapMessagesToDisplay). An `image` block (TASKS.md #82)
 * rides alongside its `show_media` call's own `tool_result` in the same message, so it counts as a continuation too —
 * never sent to the model either way (see toOpenAIMessages/toAnthropicMessages/Google's own mapping), but must not be
 * misread as the start of a new turn for trimming purposes. A `user_note` (TASKS.md #158, a mid-run steering comment)
 * is the newest case here for the identical reason: it must never fracture the turn it was injected into. */
function isPureToolResult(m: Message): boolean {
  return m.content.length > 0 && m.content.every((b) => b.type === 'tool_result' || b.type === 'image' || b.type === 'user_note')
}

/** TASKS.md #158: a `user_note` block reads as ordinary text to the MODEL — the `user_note` type is purely an
 * internal distinction for turn-boundary (`isPureToolResult` above) and UI-rendering purposes. Applied to
 * `messagesToSend` right before every `provider.stream()` call (orchestrator.ts's `runLoop`), never to what's
 * persisted or shown in the transcript, same as every other wire-only transform in this file. */
export function normalizeUserNotesForWire(messages: Message[]): Message[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.map((b): ContentBlock => (b.type === 'user_note' ? { type: 'text', text: b.text } : b))
  }))
}

/** Groups messages into complete turns (one real user message through the next), never splitting a tool_use/tool_result pair — the API rejects a dangling one. Exported for reuse by orchestrator.ts's `capRepeatedToolResults` (#149), which needs the same turn boundary to genuinely scope its cap to "the current turn" as its own doc comment always claimed but never enforced — this is the one canonical definition of a turn boundary in this codebase; a second, inconsistent one must not be invented elsewhere. */
export function splitIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = []
  for (const m of messages) {
    if (turns.length === 0 || (m.role === 'user' && !isPureToolResult(m))) {
      turns.push([m])
    } else {
      turns[turns.length - 1].push(m)
    }
  }
  return turns
}

const INTERRUPTED_TOOL_RESULT =
  '[No result was recorded for this tool call — the app was closed or the request was interrupted before it finished. ' +
  'Its outcome is unknown; do not assume it succeeded or failed.]'

function toolUseIds(m: Message): string[] {
  return m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))
}

/** True for an assistant/user message that only a delegated specialist could have produced, judged by the `agentRole` marker `ContentBlock` documents ("set means a specialist produced this block"). */
function isSpecialistAssistantMessage(m: Message): boolean {
  return (
    m.role === 'assistant' &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === 'warning' || ((b.type === 'text' || b.type === 'tool_use') && Boolean(b.agentRole)))
  )
}

/**
 * Stage 1 — a delegate call's result is persisted *after* the specialist's own
 * messages. A specialist runs in its own nested conversation (`dispatchDelegate`)
 * and every message it yields is saved to the same flat session table as it
 * happens, so the stored order is:
 *
 *   assistant  tool_use delegate_to_x        <- the parent's call
 *   assistant  tool_use write_file           <- the specialist's own (agentRole set)
 *   user       tool_result (write_file)
 *   assistant  text                          <- the specialist's own
 *   user       tool_result (delegate_to_x)   <- the parent's answer, now non-adjacent
 *
 * The parent's *live* conversation is fine (its delegate result follows its call
 * directly; the nested run never enters it). Only replay from SQLite is wrong,
 * and every provider rejects it: the delegate call looks unanswered, and its real
 * result looks like a `tool` message answering nothing — found live, a session
 * failed on every send after its first delegation with "messages with role
 * 'tool' must be a response to a preceeding message with 'tool_calls'". Audited
 * against the real DB: 4 of 6 sessions had this shape.
 *
 * The specialist's messages were never part of what the parent saw, and the
 * delegate result already carries its final text, so they are dropped from the
 * replayed history — but only when provably nested (every assistant message in
 * the gap carries `agentRole`, every result in it answers a call made inside it).
 * Anything that doesn't prove out is left for stages 2 and 3, which always
 * produce a wire-valid history.
 */
function dropNestedDelegateMessages(messages: Message[]): Message[] {
  const result: Message[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    result.push(m)
    i++
    if (m.role !== 'assistant') continue
    const ids = new Set(toolUseIds(m))
    if (ids.size === 0) continue
    const next = messages[i]
    // Already answered in place — nothing nested to remove.
    if (next && next.role === 'user' && isPureToolResult(next) && next.content.some((b) => b.type === 'tool_result' && ids.has(b.toolUseId))) continue

    let j = i
    while (j < messages.length && !(messages[j].role === 'user' && isPureToolResult(messages[j]) && messages[j].content.some((b) => b.type === 'tool_result' && ids.has(b.toolUseId)))) {
      // A real user message is a turn boundary; a delegate can't span one.
      if (messages[j].role === 'user' && !isPureToolResult(messages[j])) {
        j = messages.length
        break
      }
      j++
    }
    if (j >= messages.length || j === i) continue

    const gap = messages.slice(i, j)
    const nestedCallIds = new Set(gap.flatMap(toolUseIds))
    const provablyNested = gap.every((g) =>
      g.role === 'assistant'
        ? isSpecialistAssistantMessage(g)
        : isPureToolResult(g) && g.content.every((b) => b.type !== 'tool_result' || nestedCallIds.has(b.toolUseId))
    )
    if (provablyNested) i = j
  }
  return result
}

/**
 * Stage 2 — every `tool_use` must be answered by a `tool_result` in the message
 * immediately after it (Anthropic's `tool_use`/`tool_result`, OpenAI-compatible
 * `tool_calls`/`tool`, Google's function call/response all reject otherwise).
 * Found live: quitting the app (or abandoning a stream) while a tool call was
 * in flight persisted the assistant's `tool_use` but never a matching
 * `tool_result`, and since every later send replays the full history, that one
 * dangling block made every subsequent message in the session fail with the
 * provider's own 400 ("Not the same number of function calls and responses").
 *
 * Synthesizes an explicit error `tool_result` for each unanswered `tool_use`
 * (rather than stripping the call) so the model still sees that it tried
 * something and that the outcome is unknown. Merged into the following
 * tool_result message when there is a partial answer (parallel calls where only
 * some finished), otherwise inserted as its own message directly after the
 * assistant message — a pure-tool_result message stays in the same turn for
 * `splitIntoTurns`, so the sliding window can't separate the pair.
 */
function synthesizeMissingResults(messages: Message[]): Message[] {
  const result: Message[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    result.push(m)
    i++
    if (m.role !== 'assistant') continue
    const useIds = toolUseIds(m)
    if (useIds.length === 0) continue

    const answered = new Set<string>()
    const following: Message[] = []
    while (i < messages.length && messages[i].role === 'user' && isPureToolResult(messages[i])) {
      for (const b of messages[i].content) if (b.type === 'tool_result') answered.add(b.toolUseId)
      following.push(messages[i])
      i++
    }
    const missing = useIds.filter((id) => !answered.has(id))
    if (missing.length === 0) {
      result.push(...following)
      continue
    }
    const synthesized: ContentBlock[] = missing.map((id) => ({
      type: 'tool_result',
      toolUseId: id,
      content: INTERRUPTED_TOOL_RESULT,
      isError: true
    }))
    if (following.length === 0) {
      result.push({ role: 'user', content: synthesized })
    } else {
      const [first, ...rest] = following
      result.push({ ...first, content: [...first.content, ...synthesized] }, ...rest)
    }
  }
  return result
}

/**
 * Stage 3 — the mirror invariant: a `tool_result` must answer a `tool_use` in
 * the assistant message right before it. Anything else is dropped (a message
 * left empty is dropped entirely) — an orphan result is a guaranteed 400 from
 * every provider and carries nothing the model can use. This is the backstop
 * for whatever shape stages 1 and 2 didn't anticipate, so a session can never
 * be wedged by a stray result.
 */
function dropOrphanResults(messages: Message[]): Message[] {
  const result: Message[] = []
  let ownerIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant') {
      ownerIds = new Set(toolUseIds(m))
      result.push(m)
      continue
    }
    if (!m.content.some((b) => b.type === 'tool_result')) {
      if (!isPureToolResult(m)) ownerIds = new Set()
      result.push(m)
      continue
    }
    const kept = m.content.filter((b) => b.type !== 'tool_result' || ownerIds.has(b.toolUseId))
    if (kept.length > 0) result.push(kept.length === m.content.length ? m : { ...m, content: kept })
  }
  return result
}

/**
 * Delegate tools that no longer exist because their role was merged into
 * another (step 2 of design-discussion.md: Terminal/DevOps and Distribution
 * became the Developer, id `coding`). Saved sessions still contain calls to
 * them; replaying a call to a tool that is absent from the request's tool list
 * is a provider-compat risk (design section 8, risk gate 1), and it would show
 * the model a delegate it can no longer use. Renamed to the current name on
 * replay only — the stored transcript and the UI keep the original.
 */
const LEGACY_DELEGATE_NAMES: Readonly<Record<string, string>> = {
  delegate_to_terminal_devops: 'delegate_to_coding',
  delegate_to_distribution: 'delegate_to_coding'
}

export function migrateLegacyDelegateNames(messages: Message[]): Message[] {
  let changed = false
  const result = messages.map((m) => {
    if (!m.content.some((b) => b.type === 'tool_use' && b.name in LEGACY_DELEGATE_NAMES)) return m
    changed = true
    return {
      ...m,
      content: m.content.map((b) => (b.type === 'tool_use' && b.name in LEGACY_DELEGATE_NAMES ? { ...b, name: LEGACY_DELEGATE_NAMES[b.name] } : b))
    }
  })
  return changed ? result : messages
}

/**
 * Replays calls to tools that are NOT in the request's tool list as compact text.
 *
 * The slim router (design-discussion.md 3.1) carries only a hot core, so earlier turns' history
 * can contain calls to tools the current request does not define — the model may copy such a call
 * and get "Unknown tool", and some providers may reject a `tool_use` for a tool absent from the
 * request. Rather than verify every provider (risk gate 1), make it moot: no provider is ever
 * shown a call to a tool it was not given. The call and its result become plain text in place
 * ("[earlier: called xlsx_write(...) -> ok]"), so the model still knows what happened.
 *
 * Pairing stays valid: a converted `tool_use` and its `tool_result` both become text, and any
 * text produced from results is placed AFTER the remaining `tool_result` blocks of that message
 * (Anthropic requires tool_result blocks first). Replay-only — the stored transcript and the UI
 * are untouched, same convention as every other pass here. Returns the input array when nothing
 * needs converting.
 */
export function collapseUnavailableToolCalls(messages: Message[], availableTools: ReadonlySet<string>): Message[] {
  const absent = new Map<string, string>() // tool_use id -> tool name
  for (const m of messages) {
    for (const b of m.content) if (b.type === 'tool_use' && !availableTools.has(b.name)) absent.set(b.id, b.name)
  }
  if (absent.size === 0) return messages

  const compact = (input: Record<string, unknown>): string => {
    const json = JSON.stringify(input)
    return json.length > 160 ? json.slice(0, 160) + '…' : json
  }
  return messages.map((m) => {
    if (!m.content.some((b) => (b.type === 'tool_use' && absent.has(b.id)) || (b.type === 'tool_result' && absent.has(b.toolUseId)))) return m
    const convert = (b: ContentBlock): ContentBlock | undefined => {
      if (b.type === 'tool_use' && absent.has(b.id)) {
        return { type: 'text', text: `[earlier: called ${b.name}(${compact(b.input)})]`, ...(b.agentRole ? { agentRole: b.agentRole } : {}) }
      }
      if (b.type === 'tool_result' && absent.has(b.toolUseId)) {
        const body = b.content.length > 500 ? b.content.slice(0, 500) + '…' : b.content
        return { type: 'text', text: `[earlier result of ${absent.get(b.toolUseId)}${b.isError ? ' (error)' : ''}: ${body}]` }
      }
      return undefined
    }
    // Assistant messages: convert in place, so the model's own text keeps its order.
    if (m.role === 'assistant') return { ...m, content: m.content.map((b) => convert(b) ?? b) }
    // User messages: remaining tool_results first, converted ones after them (Anthropic requires tool_result blocks first).
    const kept: ContentBlock[] = []
    const asText: ContentBlock[] = []
    for (const b of m.content) {
      const c = convert(b)
      if (c) asText.push(c)
      else kept.push(b)
    }
    const content = [...kept, ...asText]
    return { ...m, content }
  })
}

/**
 * Makes the replayed history satisfy the tool-call pairing rule every provider
 * enforces, in both directions (no unanswered `tool_use`, no orphan
 * `tool_result`). Only affects what's sent — SQLite and the UI transcript are
 * untouched, same convention as every other pass here.
 */
export function repairToolPairs(messages: Message[]): Message[] {
  return dropOrphanResults(synthesizeMissingResults(dropNestedDelegateMessages(messages)))
}

/** A turn whose only assistant content is a whole-turn-failure warning (see `ContentBlock`'s `failureCategory` doc comment) — produced literally nothing else, not even partial text or a tool call. */
function failedTurnWarning(turn: Message[]): Extract<ContentBlock, { type: 'warning' }> | undefined {
  const assistantBlocks = turn.filter((m) => m.role === 'assistant').flatMap((m) => m.content)
  if (assistantBlocks.some((b) => b.type === 'text' || b.type === 'tool_use')) return undefined
  const warning = assistantBlocks.find((b): b is Extract<ContentBlock, { type: 'warning' }> => b.type === 'warning' && Boolean(b.failureCategory))
  return warning
}

/**
 * Whole-turn failures (TASKS.md #102, found live: a thrown provider error, a
 * Stop click before anything was produced, or an empty-output round all used
 * to leave the user's original question sitting in history with no reply,
 * silently resent as unanswered "real" context on every later call —
 * confirmed live as 4 identical retries in a row, each resending the whole
 * still-growing, still-unanswered history) are never silently resent
 * verbatim, repeat after repeat. But per explicit direction, genuine failure
 * information isn't discarded either — feeding the model *some* signal
 * about what went wrong can help it choose a different approach next time,
 * so this distinguishes two cases rather than a blanket strip:
 *
 *  - An **isolated** single failed turn is kept, but converted into real
 *    `text` content — a plain `warning` block is normally stripped from the
 *    wire format entirely by every provider adapter (`warning -> null`),
 *    which would otherwise make even a deliberately-kept failure invisible
 *    to the model.
 *  - A **run of 2+ consecutive** failed turns (the actual "repeated
 *    failures" case that motivated this) is collapsed into one synthetic
 *    turn: the most recent attempt's own question, plus a single
 *    consolidated note ("attempted N times, failed each time — most recent
 *    reason: ..."), instead of resending N near-identical, still-unanswered
 *    exchanges in full.
 *
 * Only ever affects what's *sent* — the original turns stay exactly as
 * persisted in SQLite and shown in the UI transcript, same convention as
 * every other trimming pass in this codebase.
 */
export function collapseFailedTurns(messages: Message[]): Message[] {
  const turns = splitIntoTurns(messages)
  const result: Message[][] = []
  let i = 0
  while (i < turns.length) {
    const warning = failedTurnWarning(turns[i])
    if (!warning) {
      result.push(turns[i])
      i++
      continue
    }
    const runStart = i
    while (i < turns.length && failedTurnWarning(turns[i])) i++
    const run = turns.slice(runStart, i)
    const lastQuestion = run[run.length - 1][0] // always the real user message — see splitIntoTurns
    if (run.length === 1) {
      result.push([lastQuestion, { role: 'assistant', content: [{ type: 'text', text: `[Previous attempt failed — ${warning.message}]` }] }])
    } else {
      const lastReason = failedTurnWarning(run[run.length - 1])?.message ?? warning.message
      const summary =
        `[This request was attempted ${run.length} times in a row and failed to produce an answer each time. ` +
        `Most recent reason: ${lastReason}]`
      result.push([lastQuestion, { role: 'assistant', content: [{ type: 'text', text: summary }] }])
    }
  }
  return result.flat()
}

/**
 * The context window to budget against, tried in order: (1) a provider's
 * own *live* figure (today only Ollama's `loadedContextWindow` — the
 * actual runtime-loaded context, which can differ from the model's
 * architectural max); (2) a provider's *configured* figure (today only
 * Ollama's `configuredContextWindow` — the Modelfile's own declared
 * `num_ctx`, available even while the model is currently idled out of
 * VRAM, which is Ollama's default behavior and so the *common* state of a
 * real chat session sitting between messages, not an edge case); (3) the
 * static model-metadata.ts estimate, as a last resort. Confirmed live, all
 * three states in one session: gpt-oss:20b advertises 131072 but was
 * actually loaded at 4096 (case 1 catches this); a custom 128K-context
 * Modelfile variant, idled cold, was still silently reported as the flat
 * 4096 local-model fallback because nothing before this checked its
 * *configured* value, only its live-loaded one (case 2 exists specifically
 * to fix this — found from a real user report that the UI meter was still
 * showing 4.1K on a plain app restart, no message sent yet). A live or
 * configured reading is never itself an "estimate" — both are real numbers
 * the server actually reported; `isEstimate` only means neither was
 * available and the static table's own fallback got used.
 */
export async function resolveContextWindow(model: string, provider: ModelProvider): Promise<ContextWindowInfo> {
  const loaded = await provider.loadedContextWindow?.(model)
  if (loaded !== undefined) return { tokens: loaded, isEstimate: false }
  const configured = await provider.configuredContextWindow?.(model)
  if (configured !== undefined) return { tokens: configured, isEstimate: false }
  return contextWindowFor(model)
}

export interface SlidingWindowResult {
  messages: Message[]
  /**
   * Turns actually dropped to fit budget, oldest first, kept as real
   * content rather than just a count — nothing is lost from SQLite or the
   * UI transcript either way (this only ever affects what's sent to the
   * provider), but a dropped turn does become invisible to the *model*
   * for the rest of this conversation. Callers currently just check
   * `.length` to report that a drop happened (see ipc/register.ts) — kept
   * as full `Message[][]` on purpose so a future rolling-summarization
   * pass (TASKS.md #49, deliberately not built yet) can consume the real
   * dropped content directly instead of needing to re-derive it, or
   * inject a summary here in place of a bare drop, without changing this
   * return shape again.
   */
  droppedTurns: Message[][]
  /** The real context window this turn was budgeted against — see `resolveContextWindow`. Surfaced to the renderer via a `context_window` stream event so its meter can use the real figure instead of its own static guess. */
  contextWindow: ContextWindowInfo
}

/**
 * Drops the oldest complete turns until the conversation fits the model's
 * context budget, always keeping at least the most recent turn. Re-counts
 * after each drop via `provider.countTokens` (a real API call for
 * Anthropic/Google) rather than estimating drop count upfront — simpler and
 * correct-by-construction; acceptable since this only runs when a session
 * has actually grown large enough to be over budget.
 */
export async function applySlidingWindow(
  messages: Message[],
  model: string,
  provider: ModelProvider,
  overhead?: TurnOverhead
): Promise<SlidingWindowResult> {
  const contextWindow = await resolveContextWindow(model, provider)
  const reserved = overhead ? await overheadTokens(overhead, model, provider) : 0
  // Never negative — an overhead estimate that alone exceeds the whole
  // budget still leaves *some* room (the "always keep the last turn" floor
  // below already handles the case where even that isn't enough).
  const budget = Math.max(0, Math.floor(contextWindow.tokens * CONTEXT_BUDGET_FRACTION) - reserved)
  const turns = splitIntoTurns(messages)
  const droppedTurns: Message[][] = []

  while (turns.length > 1) {
    const flat = turns.flat()
    const count = await provider.countTokens(flat, model)
    if (count <= budget) break
    const dropped = turns.shift()
    if (dropped) droppedTurns.push(dropped)
  }

  return { messages: turns.flat(), droppedTurns, contextWindow }
}

export async function prepareConversation(
  messages: Message[],
  model: string,
  provider: ModelProvider,
  overhead?: TurnOverhead
): Promise<SlidingWindowResult> {
  return applySlidingWindow(
    collapseFailedTurns(trimToolResults(repairToolPairs(migrateLegacyDelegateNames(messages)))),
    model,
    provider,
    overhead
  )
}
