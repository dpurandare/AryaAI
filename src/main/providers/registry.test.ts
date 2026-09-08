import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from './registry'
import type { ModelProvider } from './types'

function fakeProvider(id: string): ModelProvider {
  return {
    id,
    displayName: id,
    listModels: async () => [],
    countTokens: async () => 0,
    stream: async function* () {}
  }
}

describe('ProviderRegistry', () => {
  it('registers and looks up providers by id', () => {
    const registry = new ProviderRegistry()
    registry.register({
      id: 'fake',
      displayName: 'Fake',
      requiresApiKey: true,
      supportsEmbeddings: false,
      create: (key) => fakeProvider(`fake:${key}`)
    })

    const descriptor = registry.get('fake')
    expect(descriptor?.displayName).toBe('Fake')
    expect(descriptor?.create('k').id).toBe('fake:k')
  })

  it('returns undefined for an unknown provider', () => {
    expect(new ProviderRegistry().get('nope')).toBeUndefined()
  })

  it('lists every registered provider', () => {
    const registry = new ProviderRegistry()
    registry.register({
      id: 'a',
      displayName: 'A',
      requiresApiKey: true,
      supportsEmbeddings: false,
      create: () => fakeProvider('a')
    })
    registry.register({
      id: 'b',
      displayName: 'B',
      requiresApiKey: false,
      supportsEmbeddings: false,
      create: () => fakeProvider('b')
    })
    expect(registry.list().map((d) => d.id)).toEqual(['a', 'b'])
  })
})
