import { describe, expect, it } from 'vitest'
import { createDefaultWebSearchProviderRegistry } from './web-search-providers'

describe('createDefaultWebSearchProviderRegistry (#161)', () => {
  it('registers tavily (requires a key) and duckduckgo (free, always available)', () => {
    const registry = createDefaultWebSearchProviderRegistry()
    const ids = registry.list().map((p) => p.id)
    expect(ids).toContain('tavily')
    expect(ids).toContain('duckduckgo')
    expect(registry.get('tavily')?.requiresApiKey).toBe(true)
    expect(registry.get('duckduckgo')?.requiresApiKey).toBe(false)
  })

  it('returns undefined for an unregistered provider id', () => {
    const registry = createDefaultWebSearchProviderRegistry()
    expect(registry.get('serpapi')).toBeUndefined()
  })
})
