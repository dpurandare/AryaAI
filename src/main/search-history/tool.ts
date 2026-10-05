import { getEmbeddingConfig, getIndexState, searchIndex } from './indexer'
import { getEmbeddingProvider } from '../providers/setup'
import { getApiKey } from '../security/keychain'
import type { Tool } from '../tools/types'

const SEARCH_HISTORY_EXCERPT_MAX_CHARS = 800
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

const STILL_BUILDING_MESSAGE =
  "(the history index is still building (nothing indexed yet) — try again shortly, or answer " +
  'from the current conversation only. Tell the user plainly rather than guessing.)'

const NEEDS_REBUILD_MESSAGE =
  '(the history index was built with a different embedding model than is currently configured ' +
  'and needs to be rebuilt before it can be searched again. Tell the user plainly, and suggest ' +
  'clicking "Rebuild index" in Settings > Search history.)'

function notReachableMessage(err: unknown): string {
  return (
    `(history search isn't reachable right now — the configured embedding provider ` +
    `errored: ${err instanceof Error ? err.message : String(err)}. Tell the user plainly ` +
    `rather than guessing, and suggest checking that it's running/reachable.)`
  )
}

export const searchHistoryTool: Tool = {
  name: 'search_history',
  description:
    "Search the user's own past conversations — including this one — for relevant excerpts. " +
    'Useful for recalling something discussed earlier, comparing how a qualitative/quantitative ' +
    'detail changed over time (a "delta"), or recovering something from earlier in THIS ' +
    'conversation that may have aged out of your own visible context if it has grown long. ' +
    'Returns tagged excerpts with session and date so you can reason about recency/provenance. ' +
    "If it reports it's unavailable, tell the user plainly rather than silently working around " +
    'it or guessing. Excerpts are past statements, not current state — never use one to say what is ' +
    'configured or available now; check live (describe_capabilities).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for in past conversations' },
      limit: { type: 'number', description: `Max excerpts to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }
    },
    required: ['query']
  },
  mutates: false,
  async execute(input) {
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('No query given.')
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIMIT))

    const state = getIndexState()
    if (state.kind === 'needs-rebuild') return NEEDS_REBUILD_MESSAGE
    // Already known-broken from a real prior attempt (see indexer.ts's
    // lastEmbedFailureReason) — no need to re-probe reachability below,
    // it would just fail identically.
    if (state.kind === 'unavailable') return notReachableMessage(new Error(state.reason))

    if (state.kind === 'empty' || state.indexed === 0) {
      // Nothing indexed yet — the message_vectors table may not even exist,
      // so we can't tell "provider unreachable" from "just not backfilled"
      // by querying it. Probe reachability directly instead.
      try {
        const config = getEmbeddingConfig()
        const provider = getEmbeddingProvider(config.providerId, getApiKey(config.providerId))
        await provider.embed([query], config.model)
      } catch (err) {
        return notReachableMessage(err)
      }
      return STILL_BUILDING_MESSAGE
    }

    let hits
    try {
      hits = await searchIndex(query, limit)
    } catch (err) {
      return notReachableMessage(err)
    }

    if (hits.length === 0) return '(no relevant past conversations found for that query.)'

    return hits
      .map((hit) => {
        const relevance = (1 - hit.distance).toFixed(2)
        const date = new Date(hit.createdAt).toISOString().slice(0, 10)
        const excerpt = hit.text.slice(0, SEARCH_HISTORY_EXCERPT_MAX_CHARS)
        return `<historical_result session="${hit.sessionTitle}" date="${date}" relevance="${relevance}">\n${excerpt}\n</historical_result>`
      })
      .join('\n') +
      '\n(Note: these are past statements — any configuration or availability they mention may have changed since; verify current state with a live tool.)'
  }
}
