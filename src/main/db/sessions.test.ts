import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, setDbPath } from './index'
import { createSession, deleteSession, getSession, listSessions, titleFromMessage, updateSessionTitle } from './sessions'

function toVectorBuffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer)
}

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

  it('does not throw when message_vectors has never been created (nothing ever embedded)', () => {
    const session = createSession('Never embedded')
    expect(() => deleteSession(session.id)).not.toThrow()
  })

  it('also removes the session\'s rows from message_vectors, not just the SQL tables FK cascade reaches', () => {
    const db = getDb()
    const session = createSession('Has embeddings')
    const otherSession = createSession('Untouched')

    db.exec(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', '" +
        session.id +
        "', 'user', '[]', 0)"
    )
    db.exec('CREATE VIRTUAL TABLE message_vectors USING vec0(embedding float[4])')
    db.prepare(
      "INSERT INTO message_embeddings (id, message_id, session_id, model, created_at) VALUES (1, 'm1', ?, 'test-model', 0)"
    ).run(session.id)
    db.prepare('INSERT INTO message_vectors(rowid, embedding) VALUES (?, ?)').run(
      BigInt(1),
      toVectorBuffer([1, 0, 0, 0])
    )

    // A second, unrelated session's vector must survive this session's deletion.
    db.exec(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m2', '" +
        otherSession.id +
        "', 'user', '[]', 0)"
    )
    db.prepare(
      "INSERT INTO message_embeddings (id, message_id, session_id, model, created_at) VALUES (2, 'm2', ?, 'test-model', 0)"
    ).run(otherSession.id)
    db.prepare('INSERT INTO message_vectors(rowid, embedding) VALUES (?, ?)').run(
      BigInt(2),
      toVectorBuffer([0, 1, 0, 0])
    )

    deleteSession(session.id)

    const remaining = db.prepare('SELECT rowid FROM message_vectors ORDER BY rowid').all() as { rowid: number }[]
    expect(remaining).toEqual([{ rowid: 2 }])
    expect(db.prepare('SELECT id FROM message_embeddings').all()).toEqual([{ id: 2 }])
  })

  it('starts with no sessions', () => {
    expect(listSessions()).toEqual([])
  })

  it('gets a single session by id, or undefined if it does not exist', () => {
    const session = createSession('New Chat')
    expect(getSession(session.id)).toEqual(session)
    expect(getSession('does-not-exist')).toBeUndefined()
  })

  it('updates a session title in place', () => {
    const session = createSession('New Chat')
    updateSessionTitle(session.id, 'Renamed')
    expect(getSession(session.id)?.title).toBe('Renamed')
    expect(listSessions()).toHaveLength(1)
  })
})

describe('titleFromMessage', () => {
  it('uses a short message as-is', () => {
    expect(titleFromMessage('What is 12 times 12?')).toBe('What is 12 times 12?')
  })

  it('collapses internal newlines/whitespace to single spaces', () => {
    expect(titleFromMessage('line one\n\nline   two')).toBe('line one line two')
  })

  it('trims surrounding whitespace', () => {
    expect(titleFromMessage('   hello there   ')).toBe('hello there')
  })

  it('truncates a long message at a word boundary with an ellipsis', () => {
    const long =
      'I have a mathematical question: a person jumps from a 12 floor building, each floor is 15 feet high.'
    const title = titleFromMessage(long)
    expect(title.length).toBeLessThanOrEqual(51) // 50 chars + the ellipsis char
    expect(title.endsWith('…')).toBe(true)
    expect(title.endsWith(' …')).toBe(false) // no dangling space before the ellipsis
  })

  it('hard-truncates a long message with no early word boundary instead of losing most of the budget', () => {
    const long = 'a'.repeat(20) + ' ' + 'b'.repeat(60)
    const title = titleFromMessage(long)
    expect(title).toBe('a'.repeat(20) + ' ' + 'b'.repeat(29) + '…')
  })

  it('falls back to the default title for whitespace-only input', () => {
    expect(titleFromMessage('   \n\t  ')).toBe('New Chat')
  })
})
