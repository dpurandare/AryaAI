import { beforeEach, describe, expect, it } from 'vitest'
import { setDbPath } from './index'
import { createSession, deleteSession, listSessions } from './sessions'

describe('sessions repository', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('creates a session with the given title', () => {
    const session = createSession('New Chat')
    expect(session.title).toBe('New Chat')
    expect(session.id).toBeTruthy()
    expect(session.createdAt).toBe(session.updatedAt)
  })

  it('lists sessions most-recently-updated first', async () => {
    const first = createSession('First')
    // updated_at is millisecond Date.now(); force a distinct tick so ordering isn't a tie.
    await new Promise((r) => setTimeout(r, 2))
    const second = createSession('Second')
    expect(listSessions().map((s) => s.id)).toEqual([second.id, first.id])
  })

  it('deletes a session', () => {
    const session = createSession('Doomed')
    deleteSession(session.id)
    expect(listSessions()).toHaveLength(0)
  })

  it('starts with no sessions', () => {
    expect(listSessions()).toEqual([])
  })
})
