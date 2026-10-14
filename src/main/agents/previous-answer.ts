import type { ContentBlock } from '@shared/protocol'

interface MessageLike {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

/**
 * The most recent assistant answer before the current request, as Markdown (office_create_document's
 * `fromPreviousAnswer`): the last assistant message with text that precedes the latest plain user message. That user
 * message is the request being handled now — already persisted — so any assistant text after it belongs to this turn,
 * not to the answer being asked about. Tool-only rounds, thinking blocks and tool results are skipped.
 */
/**
 * The orchestrator persists each finished plan step's result as a user-role message "[Plan step N — Role]: …". That is this
 * turn's own plumbing, not the user's request. Found live (gpt-oss, "top 5 customers into a Word document"): it was taken
 * for the request, so the data step's draft reply — "I'm unable to create a Word document… [handoff: out_of_scope -> …]" —
 * counted as "the previous answer" and landed in the file.
 */
const PLAN_STEP_NOTE = /^\[Plan step \d+ /

export function previousAnswerText(messages: readonly MessageLike[]): string | undefined {
  let end = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      messages[i].role === 'user' &&
      messages[i].content.some((b) => b.type === 'text' && !PLAN_STEP_NOTE.test(b.text))
    ) {
      end = i
      break
    }
  }
  for (let i = end - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    const text = messages[i].content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n')
      .trim()
    if (text) return text
  }
  return undefined
}
