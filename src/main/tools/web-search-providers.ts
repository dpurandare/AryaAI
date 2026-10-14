/**
 * TASKS.md #161: a pluggable web-search-provider mechanism, mirroring the
 * chat-provider registry (`providers/registry.ts`/`providers/setup.ts`) —
 * a user brings whichever provider they already have a key for and picks
 * it in Settings, the same shape as the chat-provider picker, rather than
 * Sachivji pre-vetting a fixed shortlist. Tavily (already existed) is the
 * first real entry, refactored into this shape rather than replaced;
 * DuckDuckGo (the existing no-key fallback) is registered as a real,
 * always-available provider too, not an invisible special case — the same
 * way local Ollama is a real, `requiresApiKey: false` entry in the chat
 * provider registry, not a hidden default. Further named providers (Google
 * Custom Search, SerpAPI, Brave, ...) get added incrementally later, one at
 * a time, per the decided design — no upfront research needed now.
 */

export interface WebSearchOptions {
  topic: 'general' | 'news'
  limit: number
  /** Also return image results where the provider can (Tavily). */
  images?: boolean
  /** "advanced" asks Tavily for a slower, deeper search with fuller excerpts per result. */
  depth?: 'basic' | 'advanced'
}

export interface WebSearchProviderDescriptor {
  id: string
  displayName: string
  requiresApiKey: boolean
  search(apiKey: string | undefined, query: string, options: WebSearchOptions): Promise<string>
}

export class WebSearchProviderRegistry {
  private readonly providers = new Map<string, WebSearchProviderDescriptor>()

  register(descriptor: WebSearchProviderDescriptor): void {
    this.providers.set(descriptor.id, descriptor)
  }

  get(id: string): WebSearchProviderDescriptor | undefined {
    return this.providers.get(id)
  }

  list(): WebSearchProviderDescriptor[] {
    return [...this.providers.values()]
  }
}

const TAVILY_TIMEOUT_MS = 20_000
const MAX_IMAGE_RESULTS = 8
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
  images?: Array<string | { url?: string; description?: string }>
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
async function searchTavily(apiKey: string | undefined, query: string, options: WebSearchOptions): Promise<string> {
  if (!apiKey) throw new Error('No Tavily API key configured — add one in Settings > Web Search Provider.')
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit || DEFAULT_LIMIT))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: limit, topic: options.topic, ...(options.depth === 'advanced' ? { search_depth: 'advanced' } : {}), ...(options.images ? { include_images: true, include_image_descriptions: true } : {}) }),
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
    const images = (data.images ?? []).map((i) => (typeof i === 'string' ? { url: i } : i)).filter((i) => i.url).slice(0, MAX_IMAGE_RESULTS)
    if (!results.length && !images.length) return '(no results found for this query)'
    const text = results
      .filter((r) => r.title && r.url)
      .map((r) => `- ${r.title}: ${r.url}${r.published_date ? ` (${r.published_date})` : ''}\n  ${r.content ?? ''}`.trimEnd())
      .join('\n')
    if (!images.length) return text
    return `${text}\n\nImage results (download_image saves one; the description is only a caption, not proof of who is shown):\n${images.map((i) => `- ${i.url}${i.description ? ` (${i.description.slice(0, 100)})` : ''}`).join('\n')}`
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
  'named topic, or note to the user that a real web search isn\'t available yet. Pick a different ' +
  'provider in Settings > Web Search Provider for real search results instead of this fallback.)'

const MAX_RELATED = 8

function flattenTopics(topics: DuckDuckGoRelatedTopic[]): DuckDuckGoRelatedTopic[] {
  return topics.flatMap((t) => (t.Topics ? flattenTopics(t.Topics) : [t]))
}

/**
 * The no-key, always-available default — DuckDuckGo's free Instant Answer
 * API. Well-known topics with an existing summary/infobox still resolve;
 * this just doesn't pretend to be a general search engine, and the only
 * link it ever presents as a real, independently fetchable source is the
 * Abstract/Definition URL — a RelatedTopics entry is DuckDuckGo's own
 * internal category page, confirmed live to sit behind the same anti-bot
 * wall as their real search results, so it's never presented as fetchable.
 */
async function searchDuckDuckGo(_apiKey: string | undefined, query: string): Promise<string> {
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

export function createDefaultWebSearchProviderRegistry(): WebSearchProviderRegistry {
  const registry = new WebSearchProviderRegistry()
  registry.register({
    id: 'tavily',
    displayName: 'Tavily',
    requiresApiKey: true,
    search: searchTavily
  })
  registry.register({
    id: 'duckduckgo',
    displayName: 'DuckDuckGo (free, limited)',
    requiresApiKey: false,
    search: searchDuckDuckGo
  })
  return registry
}
