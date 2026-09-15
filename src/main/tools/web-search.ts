import type { Tool } from './types'

interface RelatedTopic {
  Text?: string
  FirstURL?: string
  /** Present instead of Text/FirstURL for a disambiguation-style query, whose RelatedTopics are grouped under named categories rather than listed flat. */
  Topics?: RelatedTopic[]
  Name?: string
}

interface DuckDuckGoResponse {
  Heading?: string
  Abstract?: string
  AbstractURL?: string
  AbstractSource?: string
  Answer?: string
  Definition?: string
  DefinitionURL?: string
  DefinitionSource?: string
  RelatedTopics?: RelatedTopic[]
}

const NO_RESULT_MESSAGE =
  '(no instant answer found for this query — DuckDuckGo\'s free API only covers well-known ' +
  'topics with an existing summary/infobox, not general web search. Try rephrasing toward a ' +
  'named topic, or note to the user that a real web search isn\'t available yet.)'

const MAX_RELATED = 8

/** A disambiguation-style query groups RelatedTopics under named categories (`{Name, Topics: [...]}`) instead of listing them flat — flatten one level so both shapes are handled the same way. */
function flattenTopics(topics: RelatedTopic[]): RelatedTopic[] {
  return topics.flatMap((t) => (t.Topics ? flattenTopics(t.Topics) : [t]))
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    "Look up a topic via DuckDuckGo's free Instant Answer API. Only returns results for " +
    "well-known topics that already have a summary (like an encyclopedia entry) — it is not a " +
    'general web search and will often return nothing for current-events or niche queries. The ' +
    "only link in the result that's a real, independently fetchable external page is the Source " +
    'URL (when present) — "Related" entries are DuckDuckGo\'s own internal topic-category pages ' +
    '(not real articles, and not fetchable by parse_html either), listed for informational context ' +
    'only, never as something to fetch next.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to search for' } },
    required: ['query']
  },
  mutates: false,
  async execute(input) {
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('No query given.')

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`DuckDuckGo request failed: ${response.status} ${response.statusText}`)
    }
    const data = (await response.json()) as DuckDuckGoResponse

    const lines: string[] = []
    // Surfaced so the model can judge relevance itself — DuckDuckGo's own
    // disambiguation can confidently match the wrong sense of a query
    // (confirmed live: "Python" resolved to a Cold War-era UK nuclear
    // program codename, not the programming language), and an Abstract
    // relayed without this context reads as more authoritative than it is.
    if (data.Heading) lines.push(`Matched topic: ${data.Heading}`)
    if (data.Answer) lines.push(data.Answer)
    if (data.Definition) {
      lines.push(data.Definition)
      if (data.DefinitionURL) lines.push(`Source: ${data.DefinitionURL}${data.DefinitionSource ? ` (${data.DefinitionSource})` : ''}`)
    }
    if (data.Abstract) {
      lines.push(data.Abstract)
      if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}${data.AbstractSource ? ` (${data.AbstractSource})` : ''}`)
    }

    const related = flattenTopics(data.RelatedTopics ?? [])
      .filter((t) => t.Text)
      .slice(0, MAX_RELATED)
      .map((t) => `- ${t.Text}`)
    if (related.length) {
      lines.push('Related topics (DuckDuckGo\'s own categories, informational only — not fetchable):', ...related)
    }

    return lines.length ? lines.join('\n') : NO_RESULT_MESSAGE
  }
}
