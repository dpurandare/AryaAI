import type { Tool } from './types'

interface DuckDuckGoResponse {
  Abstract?: string
  AbstractURL?: string
  AbstractSource?: string
  Answer?: string
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
}

const NO_RESULT_MESSAGE =
  '(no instant answer found for this query — DuckDuckGo\'s free API only covers well-known ' +
  'topics with an existing summary/infobox, not general web search. Try rephrasing toward a ' +
  'named topic, or note to the user that a real web search isn\'t available yet.)'

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    "Look up a topic via DuckDuckGo's free Instant Answer API. Only returns results for " +
    "well-known topics that already have a summary (like an encyclopedia entry) — it is not a " +
    'general web search and will often return nothing for current-events or niche queries.',
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
    if (data.Answer) lines.push(data.Answer)
    if (data.Abstract) {
      lines.push(data.Abstract)
      if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}${data.AbstractSource ? ` (${data.AbstractSource})` : ''}`)
    }
    const related = (data.RelatedTopics ?? [])
      .filter((t) => t.Text)
      .slice(0, 5)
      .map((t) => `- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ''}`)
    if (related.length) lines.push('Related:', ...related)

    return lines.length ? lines.join('\n') : NO_RESULT_MESSAGE
  }
}
