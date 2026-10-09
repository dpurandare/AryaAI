/** A specialist that hands a request back ends its reply with `[handoff: out_of_scope -> role]`; the chat shows the sentence, not the tag. */
const TRAILING_TAG = /\s*\[handoff:\s*(?:needs_input|out_of_scope|no_information|incomplete)[^\]]*\]\s*$/i

export function stripHandoffTag(text: string): string {
  return text.replace(TRAILING_TAG, '')
}
