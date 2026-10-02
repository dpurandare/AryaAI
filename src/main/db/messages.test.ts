import { beforeEach, describe, expect, it } from 'vitest'
import type { ContentBlock } from '@shared/protocol'
import { setDbPath } from './index'
import { insertMessage, listMessages } from './messages'
import { createSession, deleteSession, listSessions } from './sessions'

describe('messages repository', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('inserts and lists messages for a session, oldest first', () => {
    const session = createSession('Chat')
    const userBlocks: ContentBlock[] = [{ type: 'text', text: 'hi' }]
    const assistantBlocks: ContentBlock[] = [{ type: 'text', text: 'hello!' }]
    insertMessage(session.id, 'user', userBlocks)
    insertMessage(session.id, 'assistant', assistantBlocks)

    const messages = listMessages(session.id)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toEqual(userBlocks)
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toEqual(assistantBlocks)
  })

  it('round-trips agentRole-tagged content blocks through JSON storage', () => {
    const session = createSession('Chat')
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'call1', name: 'delegate_to_coding', input: { task: 'do it' } },
      { type: 'text', text: 'done', agentRole: 'coding' }
    ]
    insertMessage(session.id, 'assistant', blocks)
    expect(listMessages(session.id)[0].content).toEqual(blocks)
  })

  it('scopes messages to their own session', () => {
    const a = createSession('A')
    const b = createSession('B')
    insertMessage(a.id, 'user', [{ type: 'text', text: 'in A' }])
    insertMessage(b.id, 'user', [{ type: 'text', text: 'in B' }])
    expect(listMessages(a.id)).toHaveLength(1)
    expect(listMessages(b.id)).toHaveLength(1)
  })

  it('bumps the session updatedAt when a message is inserted', async () => {
    const session = createSession('Chat')
    await new Promise((r) => setTimeout(r, 2))
    insertMessage(session.id, 'user', [{ type: 'text', text: 'hi' }])
    const [reloaded] = listSessions()
    expect(reloaded.updatedAt).toBeGreaterThan(session.updatedAt)
  })

  it('deleting a session cascades to its messages', () => {
    const session = createSession('Doomed')
    insertMessage(session.id, 'user', [{ type: 'text', text: 'hi' }])
    deleteSession(session.id)
    expect(listMessages(session.id)).toEqual([])
  })

  it('round-trips the answering model on an assistant message, and leaves it undefined for a user message', () => {
    const session = createSession('Chat')
    insertMessage(session.id, 'user', [{ type: 'text', text: 'hi' }])
    insertMessage(session.id, 'assistant', [{ type: 'text', text: 'hello!' }], 'openai:gpt-4o-mini')

    const messages = listMessages(session.id)
    expect(messages[0].model).toBeUndefined()
    expect(messages[1].model).toBe('openai:gpt-4o-mini')
  })
})
