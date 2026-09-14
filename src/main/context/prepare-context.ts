import { contextWindowFor } from '@shared/model-metadata'
import type { ContentBlock, Message, ModelProvider } from '../providers/types'

const TOOL_RESULT_MAX_CHARS = 4000
/** Leaves headroom under the model's real limit for the response itself and further tool round-trips within the same turn — the system prompt and tool schemas are now measured directly (see `TurnOverhead`/`overheadTokens` below) rather than assumed to fit inside this fraction. */
const CONTEXT_BUDGET_FRACTION = 0.7

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
async function overheadTokens(overhead: TurnOverhead, model: string, provider: ModelProvider): Promise<number> {
  const text = `${overhead.system}\n${JSON.stringify(overhead.tools)}`
  return provider.countTokens([{ role: 'user', content: [{ type: 'text', text }] }], model)
}

/**
 * Caps any oversized tool_result content before it's sent to the provider —
 * a large file read or `git log` can otherwise balloon a request by itself.
 * Only affects what's sent; the full result stays in SQLite and the UI
 * transcript untouched, so nothing the user can see is ever silently cut.
 */
export function trimToolResults(messages: Message[]): Message[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.map((block): ContentBlock => {
      if (block.type !== 'tool_result' || block.content.length <= TOOL_RESULT_MAX_CHARS) return block
      const omitted = block.content.length - TOOL_RESULT_MAX_CHARS
      return {
        ...block,
        content: `${block.content.slice(0, TOOL_RESULT_MAX_CHARS)}\n...[truncated, ${omitted} characters omitted]`
      }
    })
  }))
}

/** A pure-tool_result message is the continuation of the turn before it (a tool round-trip), not a new one — same convention already used by the renderer (App.svelte's mapMessagesToDisplay). */
function isPureToolResult(m: Message): boolean {
  return m.content.length > 0 && m.content.every((b) => b.type === 'tool_result')
}

/** Groups messages into complete turns (one real user message through the next), never splitting a tool_use/tool_result pair — the API rejects a dangling one. */
function splitIntoTurns(messages: Message[]): Message[][] {
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

/**
 * The context window to budget against: a provider's own live figure (today
 * only Ollama's, via `loadedContextWindow` — see providers/types.ts) when it
 * has one, else the static model-metadata.ts estimate. Matters specifically
 * for local models: Ollama loads a model with a server-side context that can
 * be far smaller than the model's architectural max (confirmed live:
 * gpt-oss:20b advertises 131072 but was actually running with 4096), and
 * model-metadata.ts's generic local-model fallback (8192) doesn't know
 * that — trusting it under-trims the conversation, letting a prompt reach
 * the server's real, smaller limit and get silently truncated mid-turn with
 * zero visible output.
 */
async function resolveContextWindowTokens(model: string, provider: ModelProvider): Promise<number> {
  const loaded = await provider.loadedContextWindow?.(model)
  return loaded ?? contextWindowFor(model).tokens
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
  const windowTokens = await resolveContextWindowTokens(model, provider)
  const reserved = overhead ? await overheadTokens(overhead, model, provider) : 0
  // Never negative — an overhead estimate that alone exceeds the whole
  // budget still leaves *some* room (the "always keep the last turn" floor
  // below already handles the case where even that isn't enough).
  const budget = Math.max(0, Math.floor(windowTokens * CONTEXT_BUDGET_FRACTION) - reserved)
  const turns = splitIntoTurns(messages)
  const droppedTurns: Message[][] = []

  while (turns.length > 1) {
    const flat = turns.flat()
    const count = await provider.countTokens(flat, model)
    if (count <= budget) break
    const dropped = turns.shift()
    if (dropped) droppedTurns.push(dropped)
  }

  return { messages: turns.flat(), droppedTurns }
}

export async function prepareConversation(
  messages: Message[],
  model: string,
  provider: ModelProvider,
  overhead?: TurnOverhead
): Promise<SlidingWindowResult> {
  return applySlidingWindow(trimToolResults(messages), model, provider, overhead)
}
