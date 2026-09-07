import { randomUUID } from 'node:crypto'
import { getDb } from './index'
import type { ContentBlock } from '@shared/protocol'

export interface MessageRecord {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  createdAt: number
}

interface MessageRow {
  id: string
  sessionId: string
  role: string
  content: string
  createdAt: number
}

export function insertMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: ContentBlock[]
): MessageRecord {
  const now = Date.now()
  const id = randomUUID()
  const db = getDb()
  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, sessionId, role, JSON.stringify(content), now)
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
  return { id, sessionId, role, content, createdAt: now }
}

export function listMessages(sessionId: string): MessageRecord[] {
  const rows = getDb()
    .prepare(
      'SELECT id, session_id AS sessionId, role, content, created_at AS createdAt FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    )
    .all(sessionId) as MessageRow[]

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as 'user' | 'assistant',
    content: JSON.parse(row.content) as ContentBlock[],
    createdAt: row.createdAt
  }))
}
