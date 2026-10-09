import type { Message } from '@shared/protocol'

/**
 * Found live (manual test 9.3 / 9.5, several providers): after a direct delegation the specialist's reply is already shown to the
 * user as it is written, and the router then wrote its own final answer saying the same thing again — "There are 91 customers" twice.
 * A prompt rule did not stop it (a cheap model restates anyway), so the round loop holds the router's text and drops it when it adds
 * nothing. Deliberately lenient toward real synthesis: text that brings new words, or runs much longer than the reply, is kept.
 */

const MIN_OVERLAP = 0.8
const MAX_GROWTH = 1.5

function wordsOf(text: string): Set<string> {
  // Letters and digits only, so markdown, punctuation and the non-breaking hyphens some models emit do not matter; one-character
  // tokens (list numbering) are dropped.
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1)
  )
}

/** True when `text` only restates what the `replies` (already shown to the user) said. */
export function isRestatement(text: string, replies: readonly string[]): boolean {
  const mine = wordsOf(text)
  if (mine.size === 0 || replies.length === 0) return false
  const theirs = new Set<string>()
  for (const reply of replies) for (const w of wordsOf(reply)) theirs.add(w)
  if (mine.size > theirs.size * MAX_GROWTH + 5) return false
  let shared = 0
  for (const w of mine) if (theirs.has(w)) shared++
  return shared / mine.size >= MIN_OVERLAP
}

/**
 * The replies of the delegates that just answered — only when the last message holds nothing but successful delegate results
 * (a round that also used the router's own tools, or had a failure, is not a plain "the specialist answered" shape).
 */
export function lastDelegateReplies(conversation: readonly Message[]): string[] {
  const last = conversation.at(-1)
  const before = conversation.at(-2)
  if (!last || last.role !== 'user' || !before || before.role !== 'assistant') return []
  const delegateIds = new Set<string>()
  for (const b of before.content) if (b.type === 'tool_use' && b.name.startsWith('delegate_to_')) delegateIds.add(b.id)
  const results = last.content.filter((b) => b.type === 'tool_result')
  if (results.length === 0 || results.length !== last.content.length) return []
  const replies: string[] = []
  for (const b of results) {
    if (b.type !== 'tool_result' || !delegateIds.has(b.toolUseId) || b.isError) return []
    if (typeof b.content === 'string') replies.push(b.content)
  }
  return replies.length === results.length ? replies : []
}
