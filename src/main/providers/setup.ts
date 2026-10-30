import { AnthropicProvider } from './anthropic'
import { GoogleProvider } from './google'
import { GroqProvider } from './groq'
import { MistralProvider } from './mistral'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import { ProviderRegistry } from './registry'
import type { EmbeddingProvider } from './types'

/**
 * TASKS #214: the bundled Ollama (installers only) serves EMBEDDINGS ONLY, on its own port. Set once that server is
 * confirmed healthy, so `getEmbeddingProvider('ollama')` points at it. `undefined` (the initial value) where nothing
 * bundled exists, where the old default `localhost:11434` is right. Chat never uses it: the 'ollama' chat provider
 * talks to the user's own Ollama (below). Not used for 'ollama-cloud', which always targets ollama.com.
 */
let bundledOllamaBaseUrl: string | undefined

export function setBundledOllamaBaseUrl(baseUrl: string | undefined): void {
  bundledOllamaBaseUrl = baseUrl
}

let bundledOllamaPending = false

/** TASKS #224: true while the bundled Ollama is starting or pulling its model, i.e. embeddings do not yet have their server. */
export function setBundledOllamaPending(pending: boolean): void {
  bundledOllamaPending = pending
}

/**
 * Whether the server `getEmbeddingProvider(providerId)` would use is the final one. While the bundled Ollama is still starting, 'ollama' embeddings
 * would go to the user's own Ollama instead, which may hold a different `nomic-embed-text`: nothing should be indexed, and no digest read or adopted, against it.
 */
export function embeddingServerSettled(providerId: string): boolean {
  return providerId !== 'ollama' || !bundledOllamaPending
}

function bundledEmbeddingBaseUrl(): string | undefined {
  return bundledOllamaBaseUrl ? `${bundledOllamaBaseUrl}/v1` : undefined
}

/**
 * The address of the user's own Ollama, used by the 'ollama' chat provider (`undefined` = the default
 * `http://localhost:11434/v1`). Accepts the root address ("http://host:11434") or the OpenAI-compatible one
 * ("…/v1"). It may point to an Ollama on another machine.
 */
let ollamaChatBaseUrl: string | undefined

export function setOllamaChatBaseUrl(address: string | undefined): void {
  const trimmed = address?.trim().replace(/\/+$/, '')
  ollamaChatBaseUrl = trimmed ? (trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`) : undefined
}

export function getOllamaChatBaseUrl(): string {
  return ollamaChatBaseUrl ?? 'http://localhost:11434/v1'
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register({
    id: 'anthropic',
    displayName: 'Anthropic',
    requiresApiKey: true,
    supportsEmbeddings: false,
    create: (apiKey, options) => new AnthropicProvider(apiKey!, options)
  })
  registry.register({
    id: 'openai',
    displayName: 'OpenAI',
    requiresApiKey: true,
    supportsEmbeddings: true,
    create: (apiKey) => new OpenAIProvider(apiKey!)
  })
  registry.register({
    id: 'google',
    displayName: 'Google (Gemini)',
    requiresApiKey: true,
    supportsEmbeddings: true,
    create: (apiKey) => new GoogleProvider(apiKey!)
  })
  registry.register({
    id: 'ollama',
    displayName: 'Ollama (local)',
    requiresApiKey: false,
    supportsEmbeddings: true,
    // Chat: always the user's own Ollama, never the bundled embeddings-only server (#214).
    create: () => new OllamaProvider(getOllamaChatBaseUrl())
  })
  registry.register({
    id: 'ollama-cloud',
    displayName: 'Ollama Cloud',
    requiresApiKey: true,
    supportsEmbeddings: true,
    // #167: ollama.com's hosted offering — same OllamaProvider class, pointed at the cloud
    // OpenAI-compatible endpoint with a real key instead of localhost's unused placeholder.
    create: (apiKey) => new OllamaProvider('https://ollama.com/v1', apiKey!, 'ollama-cloud', 'Ollama Cloud')
  })
  registry.register({
    id: 'groq',
    displayName: 'Groq',
    requiresApiKey: true,
    supportsEmbeddings: false,
    create: (apiKey) => new GroqProvider(apiKey!)
  })
  registry.register({
    id: 'mistral',
    displayName: 'Mistral',
    requiresApiKey: true,
    supportsEmbeddings: true,
    create: (apiKey) => new MistralProvider(apiKey!)
  })
  return registry
}

/**
 * The only way anything in the app obtains an EmbeddingProvider — scoped to
 * the closed set of providers that actually implement one (openai/google/
 * ollama/ollama-cloud/mistral), so callers never need an `if (provider.embed)` guard.
 * Throws for anything outside that set; in practice unreachable, since
 * Settings only ever lets the user pick a `supportsEmbeddings` provider for
 * this role in the first place.
 */
export function getEmbeddingProvider(providerId: string, apiKey?: string): EmbeddingProvider {
  switch (providerId) {
    case 'openai':
      return new OpenAIProvider(apiKey!)
    case 'google':
      return new GoogleProvider(apiKey!)
    case 'ollama': {
      // Embeddings: the bundled server when there is one (it holds nomic-embed-text), otherwise the user's own Ollama.
      const baseUrl = bundledEmbeddingBaseUrl()
      return baseUrl ? new OllamaProvider(baseUrl) : new OllamaProvider(getOllamaChatBaseUrl())
    }
    case 'ollama-cloud':
      return new OllamaProvider('https://ollama.com/v1', apiKey!, 'ollama-cloud', 'Ollama Cloud')
    case 'mistral':
      return new MistralProvider(apiKey!)
    default:
      throw new Error(`"${providerId}" does not support embeddings.`)
  }
}

/**
 * TASKS.md #162: a model's embedding dimension isn't knowable ahead of time from its name alone in this
 * app (`db/schema.sql`'s `embedding_index_meta.dimension` is only ever learned empirically from a real
 * embed call, same reasoning here) — so rather than a hardcoded per-model lookup table that could be wrong
 * or missing for a newer/uncommon model, Settings fires one small real embed call when the user picks a
 * model and shows the real, returned dimension. One word ("test") is enough; the actual text embedded
 * doesn't matter, only the length of the vector that comes back.
 */
export async function probeEmbeddingDimension(providerId: string, apiKey: string | undefined, model: string): Promise<number> {
  const provider = getEmbeddingProvider(providerId, apiKey)
  const [vector] = await provider.embed(['test'], model)
  return vector.length
}
