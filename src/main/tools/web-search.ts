import { getSetting } from '../db/settings'
import { getApiKey } from '../security/keychain'
import type { Tool } from './types'
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
    'topic search can miss recent coverage.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
      topic: { type: 'string', enum: ['general', 'news'], description: '"news" for current-events/latest-update queries, where the active provider supports it' },
      limit: { type: 'number', description: `Max results, where the active provider supports it (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }
    },
    required: ['query']
  },
  mutates: false,
  async execute(input) {
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('No query given.')

    const { id, apiKey } = resolveProvider(defaultRegistry)
    const descriptor = defaultRegistry.get(id)!
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIMIT))
    const topic = input.topic === 'news' ? 'news' : 'general'
    return descriptor.search(apiKey, query, { topic, limit })
  }
}
