import { AnthropicProvider } from './anthropic'
import { GoogleProvider } from './google'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import { ProviderRegistry } from './registry'

export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register({
    id: 'anthropic',
    displayName: 'Anthropic',
    requiresApiKey: true,
    create: (apiKey) => new AnthropicProvider(apiKey!)
  })
  registry.register({
    id: 'openai',
    displayName: 'OpenAI',
    requiresApiKey: true,
    create: (apiKey) => new OpenAIProvider(apiKey!)
  })
  registry.register({
    id: 'google',
    displayName: 'Google (Gemini)',
    requiresApiKey: true,
    create: (apiKey) => new GoogleProvider(apiKey!)
  })
  registry.register({
    id: 'ollama',
    displayName: 'Ollama (local)',
    requiresApiKey: false,
    create: () => new OllamaProvider()
  })
  return registry
}
