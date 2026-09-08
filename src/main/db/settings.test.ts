import { beforeEach, describe, expect, it } from 'vitest'
import { setDbPath } from './index'
import { getSetting, setSetting } from './settings'

describe('settings repository', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('returns undefined for a key that was never set', () => {
    expect(getSetting('missing')).toBeUndefined()
  })

  it('stores and retrieves a value', () => {
    setSetting('activeProviderId', 'openai')
    expect(getSetting('activeProviderId')).toBe('openai')
  })

  it('overwrites an existing value for the same key', () => {
    setSetting('activeProviderId', 'openai')
    setSetting('activeProviderId', 'anthropic')
    expect(getSetting('activeProviderId')).toBe('anthropic')
  })

  it('keeps different keys independent', () => {
    setSetting('model:openai', 'gpt-4o')
    setSetting('model:anthropic', 'claude-sonnet-5')
    expect(getSetting('model:openai')).toBe('gpt-4o')
    expect(getSetting('model:anthropic')).toBe('claude-sonnet-5')
  })
})
