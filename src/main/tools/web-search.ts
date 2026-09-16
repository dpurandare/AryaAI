import { getApiKey } from '../security/keychain'
import type { Tool } from './types'

// A generic keychain-backed key, not a registered LLM provider — reuses the
// exact same setApiKey/getApiKey plumbing every provider/embedding key
// already goes through (see SettingsPanel.svelte's "Web search" section).
const TAVILY_KEY_ID = 'tavily'
const TAVILY_TIMEOUT_MS = 20_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

interface TavilyResult {
  title?: string
  url?: string
  content?: string
  published_date?: string
}

interface TavilyResponse {
  results?: TavilyResult[]
}

/**
 * A real search API built for AI agents (not scraped, not a narrow
 * instant-answer lookup) — added after DuckDuckGo's actual search-results
 * page was confirmed live to be unreliably blocked by anti-bot protection,
 * and Google's Custom Search API turned out to no longer offer full-web
 * search to new signups (a January 2026 policy change, confirmed against
 * Google's own support docs) — see project memory for the full
 * investigation. `topic: 'news'` matters for exactly the "latest on X"
 * queries that kept coming back empty from the old DuckDuckGo path.
 */
async function searchTavily(
  apiKey: string,
  query: string,
  limit: number,
  topic: 'general' | 'news'
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: limit, topic }),
      signal: controller.signal
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Tavily search failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`
      )
    }
    const data = (await response.json()) as TavilyResponse
    const results = data.results ?? []
    if (!results.length) return '(no results found for this query)'
    return results
      .filter((r) => r.title && r.url)
      .map((r) => `- ${r.title}: ${r.url}${r.published_date ? ` (${r.published_date})` : ''}\n  ${r.content ?? ''}`.trimEnd())
      .join('\n')
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Tavily search timed out after ${TAVILY_TIMEOUT_MS}ms.`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

interface DuckDuckGoRelatedTopic {
  Text?: string
  FirstURL?: string
  /** Present instead of Text/FirstURL for a disambiguation-style query, whose RelatedTopics are grouped under named categories rather than listed flat. */
  Topics?: DuckDuckGoRelatedTopic[]
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
  RelatedTopics?: DuckDuckGoRelatedTopic[]
}

const NO_RESULT_MESSAGE =
  '(no instant answer found for this query — DuckDuckGo\'s free API only covers well-known ' +
  'topics with an existing summary/infobox, not general web search. Try rephrasing toward a ' +
  'named topic, or note to the user that a real web search isn\'t available yet. Add a Tavily ' +
  'API key in Settings > Web search for real search results instead of this fallback.)'

const MAX_RELATED = 8

function flattenTopics(topics: DuckDuckGoRelatedTopic[]): DuckDuckGoRelatedTopic[] {
  return topics.flatMap((t) => (t.Topics ? flattenTopics(t.Topics) : [t]))
}

/**
 * The no-key fallback — DuckDuckGo's free Instant Answer API. Deliberately
 * kept, not removed, so the tool still does *something* useful without any
 * setup: well-known topics with an existing summary/infobox still resolve;
 * this just no longer pretends to be a general search engine, and the only
 * link it ever presents as a real, independently fetchable source is the
 * Abstract/Definition URL — a RelatedTopics entry is DuckDuckGo's own
 * internal category page, confirmed live to sit behind the same anti-bot
 * wall as their real search results, so it's never presented as fetchable.
 */
async function searchDuckDuckGo(query: string): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`DuckDuckGo request failed: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as DuckDuckGoResponse

  const lines: string[] = []
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

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web. Uses a real search API (Tavily) with real ranked results and real, independently ' +
    'fetchable URLs when a key is configured in Settings > Web search. Set topic to "news" for a ' +
    "current-events/latest-update style query — this matters, general topic search can miss recent " +
    "coverage. Falls back to DuckDuckGo's free Instant Answer API when no Tavily key is configured — " +
    'that fallback only covers well-known topics with an existing summary/infobox, not general search, ' +
    'and its "Related" entries are DuckDuckGo\'s own internal category pages, not real fetchable sources.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
      topic: { type: 'string', enum: ['general', 'news'], description: 'Tavily only: "news" for current-events/latest-update queries' },
      limit: { type: 'number', description: `Tavily only: max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }
    },
    required: ['query']
  },
  mutates: false,
  async execute(input) {
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('No query given.')

    const tavilyKey = getApiKey(TAVILY_KEY_ID)
    if (tavilyKey) {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIMIT))
      const topic = input.topic === 'news' ? 'news' : 'general'
      return searchTavily(tavilyKey, query, limit, topic)
    }

    return searchDuckDuckGo(query)
  }
}
