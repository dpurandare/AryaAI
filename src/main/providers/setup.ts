import { AnthropicProvider } from './anthropic'
import { GoogleProvider } from './google'
import { GroqProvider } from './groq'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import { ProviderRegistry } from './registry'
import type { EmbeddingProvider } from './types'

export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register({
    id: 'anthropic',
    displayName: 'Anthropic',
    requiresApiKey: true,
    supportsEmbeddings: false,
    create: (apiKey) => new AnthropicProvider(apiKey!)
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
    create: () => new OllamaProvider()
  })
  registry.register({
    id: 'groq',
    displayName: 'Groq',
    requiresApiKey: true,
    supportsEmbeddings: false,
    create: (apiKey) => new GroqProvider(apiKey!)
  })
  return registry
}

/**
 * The only way anything in the app obtains an EmbeddingProvider — scoped to
 * the closed set of providers that actually implement one, so callers never
 * need an `if (provider.embed)` guard. Throws for anything outside that set;
 * in practice unreachable, since Settings only ever lets the user pick a
 * `supportsEmbeddings` provider for this role in the first place.
 */
export function getEmbeddingProvider(providerId: string, apiKey?: string): EmbeddingProvider {
  switch (providerId) {
    case 'openai':
      return new OpenAIProvider(apiKey!)
    case 'google':
      return new GoogleProvider(apiKey!)
    case 'ollama':
      return new OllamaProvider()
    default:
      throw new Error(`"${providerId}" does not support embeddings.`)
  }
}
