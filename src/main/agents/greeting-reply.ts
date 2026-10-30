/**
 * TASKS #242: a pinned specialist's greeting, enforced in code. The notice in the system prompt asks for the specialist's name, what it does and its
 * tools by name, and no generic closing offer; a strong model follows it, `gpt-4o-mini` only partly (probe 2026-10-27: 8 of 11 `Hello` replies still ended
 * "How can I assist you today?", 5 named no tool). So the reply is checked here, deterministically, and corrected: a trailing generic offer is removed and,
 * when the reply names none of the role's tools, a plain "My tools: …" sentence is appended. Nothing else the model wrote is touched.
 */

export type GreetingKind = 'greeting' | 'capabilities'

const GREETING = /^(hi|hello|hey|hiya|hola|namaste|howdy|yo|greetings|good\s+(morning|afternoon|evening)|hi there|hello there|hey there)(\s+\w+){0,2}\s*[!.,?]*$/i
const CAPABILITIES =
  /^(please\s+)?((what|which)\s+(can|could)\s+you\s+do|what\s+do\s+you\s+do|what\s+(are\s+)?your\s+(abilities|capabilities|skills)|(what|which)\s+tools\s+(do\s+you\s+have|can\s+you\s+use|are\s+available)|who\s+are\s+you|what\s+are\s+you|what\s+is\s+your\s+role)\b[^.!]{0,25}[?!.]*$/i

/** Whether a user message is only a greeting, or only a question about what the specialist can do; anything else is real work and is never touched. */
export function classifyGreeting(userText: string): GreetingKind | undefined {
  const text = userText.trim()
  if (text.length === 0 || text.length > 60 || text.includes('\n')) return undefined
  if (GREETING.test(text)) return 'greeting'
  if (CAPABILITIES.test(text)) return 'capabilities'
  return undefined
}

/** A closing sentence that offers help in general, which the greeting notice forbids ("How can I assist you today?", "Feel free to ask…", "Let me know…"). */
const GENERIC_CLOSING = [
  /^(so\s+|now\s+)?(how|what)\s+(can|may|could|shall|should)\s+(i|we)\s+(assist|help|do|support)\b.*$/i,
  /^(is\s+there\s+)?anything\s+(else\s+)?(i\s+can|you['’]d\s+like|you\s+would\s+like|specific).*$/i,
  /^(please\s+|just\s+)?(feel\s+free|don['’]t\s+hesitate|let\s+me\s+know|tell\s+me)\b.*$/i,
  /^(i['’]m|i\s+am)\s+(here|ready|happy|glad)\s+to\s+(help|assist)\b.*$/i,
  /^(what|how)\s+would\s+you\s+like\b.*$/i
]

/** Splits the end of a reply into sentences (keeping the text before them intact) so the trailing ones can be tested one at a time. */
function splitLastSentence(text: string): { head: string; last: string } {
  const trimmed = text.replace(/\s+$/, '')
  const matches = [...trimmed.matchAll(/[.!?]["')\]]*\s+|\n+/g)]
  const cut = matches.length ? (matches[matches.length - 1].index ?? 0) + matches[matches.length - 1][0].length : 0
  return { head: trimmed.slice(0, cut), last: trimmed.slice(cut) }
}

/** Removes trailing generic offers (at most two sentences), leaving everything before them exactly as written. */
export function stripGenericClosing(reply: string): string {
  let text = reply.replace(/\s+$/, '')
  for (let i = 0; i < 2; i++) {
    const { head, last } = splitLastSentence(text)
    if (!last || !GENERIC_CLOSING.some((re) => re.test(last.trim()))) break
    if (head.trim().length === 0) return text // never strip the whole reply
    text = head.replace(/\s+$/, '')
  }
  return text
}

/**
 * The corrected reply: generic closing removed and, if the reply mentions none of the role's tool names, a sentence listing them (about eight for a
 * greeting, all of them for "what can you do?"), and, if the reply never uses the specialist's Agent-menu name, a first sentence giving it. A role with no tools gets no
 * list. Idempotent.
 */
export function enforceGreetingReply(reply: string, kind: GreetingKind, toolNames: readonly string[], label?: string): string {
  let text = stripGenericClosing(reply)
  // The specialist must call itself by its Agent-menu name; a reply that never does (typical for "what can you do?") gets it said up front.
  const firstWord = label?.trim().split(/\s+/)[0]?.toLowerCase()
  if (label && firstWord && !text.toLowerCase().includes(firstWord)) text = `I'm ${label}. ${text}`
  if (toolNames.length > 0 && !toolNames.some((name) => text.includes(name))) {
    const listed = kind === 'greeting' ? toolNames.slice(0, 8) : toolNames
    const more = kind === 'greeting' && toolNames.length > listed.length ? ', and more' : ''
    text += `${/[.!?]$/.test(text) ? '' : '.'}\n\nMy tools: ${listed.join(', ')}${more}.`
  }
  return text
}
