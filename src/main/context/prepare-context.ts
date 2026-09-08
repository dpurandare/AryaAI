import { contextWindowFor } from '@shared/model-metadata'
import type { ContentBlock, Message, ModelProvider } from '../providers/types'

const TOOL_RESULT_MAX_CHARS = 4000
/** Leaves headroom under the model's real limit for the system prompt, the response itself, and further tool round-trips within the same turn. */
const CONTEXT_BUDGET_FRACTION = 0.7

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
  provider: ModelProvider
): Promise<Message[]> {
  const budget = Math.floor(contextWindowFor(model).tokens * CONTEXT_BUDGET_FRACTION)
  const turns = splitIntoTurns(messages)

  while (turns.length > 1) {
    const flat = turns.flat()
    const count = await provider.countTokens(flat, model)
    if (count <= budget) break
    turns.shift()
  }

  return turns.flat()
}

export async function prepareConversation(
  messages: Message[],
  model: string,
  provider: ModelProvider
): Promise<Message[]> {
  return applySlidingWindow(trimToolResults(messages), model, provider)
}
