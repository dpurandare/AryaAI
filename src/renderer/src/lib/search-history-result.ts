/**
 * Parses search_history's own tagged excerpt format (main/search-history/
 * tool.ts's `<historical_result session="..." date="..." relevance="...">`
 * blocks) back into structured pieces for display, so the chat view can
 * render each excerpt's body through MarkdownText (markdown + KaTeX) with a
 * small session/date/relevance header instead of dumping the raw tagged
 * string as unrendered plain text.
 */
export interface HistoricalResult {
  session: string
  date: string
  relevance: string
  text: string
}

// The date group anchors the match (a fixed YYYY-MM-DD shape from tool.ts's
// `.toISOString().slice(0, 10)`), so a session title containing a literal
// `"` doesn't break the non-greedy session capture ahead of it.
const RESULT_RE =
  /<historical_result session="([^]*?)" date="(\d{4}-\d{2}-\d{2})" relevance="([\d.]+)">\n([\s\S]*?)\n<\/historical_result>/g

/**
 * Returns the parsed excerpts, or `null` when `text` isn't in that shape —
 * search_history's other, plain informational returns ("still building",
 * "not reachable", "no results", "needs rebuild") should fall back to
 * being shown as plain text unchanged, not silently disappear because
 * nothing matched.
 */
export function parseSearchHistoryResult(text: string): HistoricalResult[] | null {
  const results: HistoricalResult[] = []
  for (const match of text.matchAll(RESULT_RE)) {
    const [, session, date, relevance, body] = match
    results.push({ session, date, relevance, text: body })
  }
  return results.length > 0 ? results : null
}
