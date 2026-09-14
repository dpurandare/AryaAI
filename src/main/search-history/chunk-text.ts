const MIN_CHUNK_CHARS = 20

/**
 * Splits a message's searchable text into paragraph-sized chunks so each
 * topic in a multi-topic reply gets its own vector at index time, instead
 * of one blended embedding for the whole message. Found live: a genuinely
 * authored compound-question answer ("tallest mountain discussed" +
 * "horizontal speed for a landing") was stored and embedded as one blob —
 * a later query matching the mountain half returned the landing-speed half
 * too, since retrieval operated at message granularity. Splitting on blank
 * lines matches this app's actual observed composite-answer shape: a
 * heading + its own content, separated from the next section by one blank
 * line, with no blank line *inside* a section (confirmed against a real
 * example) — so a single-topic message (the common case) still yields
 * exactly one chunk, unchanged from indexing the whole text.
 */
export function chunkText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_CHUNK_CHARS)
  // Never silently drop a short-but-real message (e.g. "OK.") just because
  // every paragraph fell under the noise floor.
  return paragraphs.length > 0 ? paragraphs : [trimmed]
}
