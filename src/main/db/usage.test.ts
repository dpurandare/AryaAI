import { beforeEach, describe, expect, it } from 'vitest'
import { setDbPath } from './index'
import { createSession } from './sessions'
import { addUsage, getUsage } from './usage'

describe('session usage repository', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('starts at zero for a session with no recorded usage', () => {
    const session = createSession('New Chat')
    expect(getUsage(session.id)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('accumulates additively across multiple calls, not overwrites', () => {
    const session = createSession('Chat')
    addUsage(session.id, 100, 20)
    addUsage(session.id, 50, 10)
    expect(getUsage(session.id)).toEqual({ inputTokens: 150, outputTokens: 30 })
  })

  it('keeps usage independent per session', () => {
    const a = createSession('A')
    const b = createSession('B')
    addUsage(a.id, 100, 10)
    addUsage(b.id, 5, 1)
    expect(getUsage(a.id)).toEqual({ inputTokens: 100, outputTokens: 10 })
    expect(getUsage(b.id)).toEqual({ inputTokens: 5, outputTokens: 1 })
  })
})
