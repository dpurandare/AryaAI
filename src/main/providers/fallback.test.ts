import { describe, expect, it } from 'vitest'
import { fallbackNotice, usableFallback } from './fallback'

const registry: Record<string, { displayName: string; requiresApiKey: boolean }> = {
  anthropic: { displayName: 'Anthropic', requiresApiKey: true },
  ollama: { displayName: 'Ollama (local)', requiresApiKey: false }
}
const lookup = (id: string) => registry[id]
const withKey = () => true

describe('usableFallback (#225)', () => {
  it('needs consent, a provider and a model', () => {
    expect(usableFallback({ providerId: 'anthropic', model: 'm', consent: false }, lookup, withKey)).toBeUndefined()
    expect(usableFallback({ providerId: 'anthropic', consent: true }, lookup, withKey)).toBeUndefined()
    expect(usableFallback({ model: 'm', consent: true }, lookup, withKey)).toBeUndefined()
  })

  it('returns the target when everything is in place', () => {
    expect(usableFallback({ providerId: 'anthropic', model: 'claude-haiku-5-5', consent: true }, lookup, withKey)).toEqual({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      model: 'claude-haiku-5-5'
    })
  })

  it('refuses a local provider, an unknown provider and a provider without a key', () => {
    expect(usableFallback({ providerId: 'ollama', model: 'm', consent: true }, lookup, withKey)).toBeUndefined()
    expect(usableFallback({ providerId: 'nope', model: 'm', consent: true }, lookup, withKey)).toBeUndefined()
    expect(usableFallback({ providerId: 'anthropic', model: 'm', consent: true }, lookup, () => false)).toBeUndefined()
  })

  it('the notice names the fallback model and says the conversation was sent', () => {
    const text = fallbackNotice({ providerId: 'anthropic', displayName: 'Anthropic', model: 'claude-haiku-5-5' })
    expect(text).toContain('Ollama (local) is not running')
    expect(text).toContain('Anthropic claude-haiku-5-5')
    expect(text).toContain('Your conversation was sent to Anthropic')
  })
})
