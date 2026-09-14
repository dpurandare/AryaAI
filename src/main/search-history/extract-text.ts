import type { ContentBlock } from '@shared/protocol'

/**
 * search_history's own tool_result is a *copy* of already-indexed content
 * (or one of its own diagnostic messages), never new information — indexing
 * it again creates exactly the kind of noise the tool exists to avoid.
 * Found live: a query for "second tallest mountain" returned an unrelated
 * landing-speed calculation, because an earlier session's own relayed
 * search_history results (a batch that happened to include one unrelated
 * hit — KNN has no relevance threshold, by design, so a genuinely useful
 * sparse match isn't lost) had themselves been indexed as if they were that
 * session's own original content, permanently bundling the unrelated topic
 * into a new indexed entry. This compounds every time a recall question
 * gets asked, since each relay-and-reindex cycle creates more copies.
 * Recognized from the tool's own two output shapes (tool.ts) — a real
 * result is always wrapped in `<historical_result>` tags, and every one of
 * its plain diagnostic messages starts with `(`.
 */
function isSearchHistoryOwnOutput(text: string): boolean {
  return (
    text.startsWith('<historical_result') ||
    text.startsWith('(no relevant past conversations found') ||
    text.startsWith('(the history index') ||
    text.startsWith('(history search')
  )
}

/**
 * Pulls plain, embeddable text out of a message's content blocks — `.text`
 * from text blocks, `.content` from tool_result blocks (except
 * search_history's own, see above). `tool_use` blocks carry no free text
 * (just a name + structured input) and are skipped. A message with no
 * remaining text (entirely tool_use, or a skipped search_history result)
 * yields '' and is skipped from indexing by the caller — nothing meaningful
 * left to embed.
 */
export function extractSearchableText(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_result' && !isSearchHistoryOwnOutput(block.content)) return block.content
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}
