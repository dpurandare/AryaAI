import type { ModelProvider, ProviderOptions } from './types'

export interface ProviderDescriptor {
  id: string
  displayName: string
  /** False for providers that don't need a stored API key, e.g. a local Ollama server. */
  requiresApiKey: boolean
  /**
   * Display/filtering metadata for the Settings embedding-provider picker —
   * separate from actually constructing a working EmbeddingProvider, which
   * only `getEmbeddingProvider()` (providers/setup.ts) does.
   */
  supportsEmbeddings: boolean
  create(apiKey?: string, options?: ProviderOptions): ModelProvider
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>()

  register(descriptor: ProviderDescriptor): void {
    this.providers.set(descriptor.id, descriptor)
  }

  get(id: string): ProviderDescriptor | undefined {
    return this.providers.get(id)
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()]
  }
}
