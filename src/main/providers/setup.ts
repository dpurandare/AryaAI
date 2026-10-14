import { AnthropicProvider } from './anthropic'
import { GoogleProvider } from './google'
import { GroqProvider } from './groq'
import { MistralProvider } from './mistral'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import { ProviderRegistry } from './registry'
import type { EmbeddingProvider } from './types'

/**
 * Set once the bundled Windows-sponsor-build Ollama server (TASKS #202) is confirmed healthy,
 * so every 'ollama' provider instance below — both the registry's and `getEmbeddingProvider`'s
 * own, separate construction of one — points at its actual port instead of assuming the
 * default `localhost:11434`. `undefined` (the initial value) on every other build/platform,
 * where nothing bundled exists and the old default is exactly right. Not used for
 * 'ollama-cloud', which always targets ollama.com regardless.
 */
let bundledOllamaBaseUrl: string | undefined

export function setBundledOllamaBaseUrl(baseUrl: string | undefined): void {
  bundledOllamaBaseUrl = baseUrl
}

function ollamaChatBaseUrl(): string | undefined {
  return bundledOllamaBaseUrl ? `${bundledOllamaBaseUrl}/v1` : undefined
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
    create: () => {
      const baseUrl = ollamaChatBaseUrl()
      return baseUrl ? new OllamaProvider(baseUrl) : new OllamaProvider()
    }
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
      const baseUrl = ollamaChatBaseUrl()
      return baseUrl ? new OllamaProvider(baseUrl) : new OllamaProvider()
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
