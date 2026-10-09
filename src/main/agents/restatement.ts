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

/**
 * Delegate calls that just came back with nothing at all — a failed result whose whole content is the "(no response)" placeholder
 * (a specialist that produced files or data before going quiet is not empty). Returns each call's delegate tool name.
 */
export function emptyDelegateCalls(conversation: readonly Message[]): string[] {
  const last = conversation.at(-1)
  const before = conversation.at(-2)
  if (!last || last.role !== 'user' || !before || before.role !== 'assistant') return []
  const names = new Map<string, string>()
  for (const b of before.content) if (b.type === 'tool_use' && b.name.startsWith('delegate_to_')) names.set(b.id, b.name)
  const empty: string[] = []
  for (const b of last.content) {
    if (b.type === 'tool_result' && b.isError && typeof b.content === 'string' && b.content.trim() === '(no response)') {
      const name = names.get(b.toolUseId)
      if (name) empty.push(name)
    }
  }
  return empty
}

const PLAN_NOTE = /^\[Plan step \d+ [^\]]*\][\s\S]*?\n\nResult:\n([\s\S]*)$/

/**
 * The replies of this turn's finished plan steps — all already shown to the user as each step finished. The final round of a plan
 * is the router writing up after them, and found live (IEC 61400-26 question, claude-haiku-5-5) it re-presented about three
 * quarters of what the two steps had just said.
 */
export function planStepReplies(conversation: readonly Message[]): string[] {
  const replies: string[] = []
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = conversation[i]
    if (m.role !== 'user') continue
    for (const b of m.content) {
      if (b.type !== 'text') continue
      const match = PLAN_NOTE.exec(b.text)
      if (!match) return replies.reverse()
      replies.push(match[1])
    }
  }
  return replies.reverse()
}

/** Scratch files the app keeps for its own use. They are not deliverables and are not for the reader. */
const INTERNAL_PATH = /\.sachiv-handoff|(^|[\s`'"(/])tmp\/research-notes-[\w-]+\.md/

export function isInternalWorkFile(path: string): boolean {
  return INTERNAL_PATH.test(path)
}

/** Removes every sentence that names an internal scratch file (found live: "Research notes are saved at tmp/research-notes-….md"). */
export function stripInternalPaths(text: string): string {
  if (!INTERNAL_PATH.test(text)) return text
  return text
    .split('\n')
    .map((line) => (INTERNAL_PATH.test(line) ? line.split(/(?<=[.!?])\s+/).filter((sentence) => !INTERNAL_PATH.test(sentence)).join(' ') : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
