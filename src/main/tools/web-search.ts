import { getSetting } from '../db/settings'
import { getApiKey } from '../security/keychain'
import type { Tool } from './types'
import { recordKnownUrl } from './data-formats/link-registry'
import { createDefaultWebSearchProviderRegistry, type WebSearchProviderRegistry } from './web-search-providers'

/** TASKS.md #161. Renderer-side literal is `'webSearchProviderId'` in SettingsPanel.svelte — same cross-process
 * string-literal-matching convention every other setting key here already uses (e.g. embeddingProviderId). */
export const WEB_SEARCH_PROVIDER_SETTING_KEY = 'webSearchProviderId'
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

const defaultRegistry = createDefaultWebSearchProviderRegistry()

/**
 * Resolves which provider to actually use for a call — **never breaks an existing user's setup**: if
 * `webSearchProviderId` was never explicitly set (true for every session before #161 shipped), this
 * preserves the exact behavior that existed before a provider picker did — Tavily if a key is already
 * configured, DuckDuckGo otherwise — rather than silently defaulting everyone to `duckduckgo` the moment
 * this setting is introduced. Once the user actually picks a provider in Settings, that choice is honored
 * exactly, including falling back to DuckDuckGo if the chosen provider needs a key it doesn't have (a
 * configured-but-not-set-up provider degrading gracefully, not erroring out).
 */
function resolveProvider(registry: WebSearchProviderRegistry): { id: string; apiKey: string | undefined } {
  const configuredId = getSetting(WEB_SEARCH_PROVIDER_SETTING_KEY)
  const id = configuredId ?? (getApiKey('tavily') ? 'tavily' : 'duckduckgo')
  const descriptor = registry.get(id) ?? registry.get('duckduckgo')!
  if (!descriptor.requiresApiKey) return { id: descriptor.id, apiKey: undefined }
  const apiKey = getApiKey(descriptor.id)
  if (!apiKey) return { id: 'duckduckgo', apiKey: undefined }
  return { id: descriptor.id, apiKey }
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web. Uses whichever provider is configured in Settings > Web Search Provider (Tavily gives ' +
    'real ranked results with real, independently fetchable URLs; DuckDuckGo, the free default, only covers ' +
    "well-known topics with an existing summary/infobox, not general search). Set topic to \"news\" for a " +
    'current-events/latest-update style query where the active provider supports it — this matters, general ' +
    'topic search can miss recent coverage. images:true adds image URLs (Tavily) for download_image.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
      topic: { type: 'string', enum: ['general', 'news'], description: '"news" for current-events/latest-update queries, where the active provider supports it' },
      limit: { type: 'number', description: `Max results, where the active provider supports it (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      images: { type: 'boolean', description: 'Add image URLs (Tavily)' }
    },
    required: ['query']
  },
  mutates: false,
  async execute(input, ctx) {
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('No query given.')

    const { id, apiKey } = resolveProvider(defaultRegistry)
    const descriptor = defaultRegistry.get(id)!
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIMIT))
    const topic = input.topic === 'news' ? 'news' : 'general'
    const images = input.images === true
    const text = await descriptor.search(apiKey, query, { topic, limit, images })
    // Every URL the search actually returned counts as a real one for this session (see link-registry.ts).
    for (const url of text.match(/https?:\/\/[^\s)]+/g) ?? []) recordKnownUrl(ctx.currentSessionId, url)
    if (images && id !== 'tavily') {
      return `(Image search needs a Tavily key — this provider returned text only. Use parse_html on a page that shows the picture, then download_image.)\n${text}`
    }
    return text
  }
}
