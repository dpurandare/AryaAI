const MIN_CHUNK_CHARS = 20

/**
 * TASKS.md #171: a paragraph-split chunk has no upper bound by itself — found live, a 30KB+ raw
 * `tool_result` JSON blob (no blank lines anywhere in it, so it survived paragraph-splitting as one
 * single chunk) got sent whole to the embedding model, exceeding `nomic-embed-text`'s real 2048-token
 * context and **segfaulting** Ollama's `llama-server` (confirmed live via `journalctl`). Any single
 * chunk this large is also fairly useless for semantic search regardless — a hard character ceiling,
 * applied after paragraph-splitting, keeps every chunk actually sent to `embed()` well under any real
 * embedding model's context window, independent of model/provider. Same cap as `TOOL_RESULT_MAX_CHARS`
 * elsewhere in this codebase (`context/prepare-context.ts`) — not load-bearing, just a familiar,
 * already-proven-safe size rather than a new number to separately justify.
 */
const MAX_CHUNK_CHARS = 4000

/** A hard, position-based split (no attempt at a "nice" boundary) — this only ever runs on a chunk that
 * already failed to split on anything semantic (no blank lines), so there is no better boundary to find. */
function splitOversized(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text]
  const parts: string[] = []
  for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) parts.push(text.slice(i, i + MAX_CHUNK_CHARS))
  return parts
}

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
  const base = paragraphs.length > 0 ? paragraphs : [trimmed]
  return base.flatMap(splitOversized)
}
