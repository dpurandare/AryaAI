import { randomUUID } from 'node:crypto'
import { getDb } from './index'
import type { ContentBlock } from '@shared/protocol'

export interface MessageRecord {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  createdAt: number
  /** "<providerId>:<model>" that produced this message — assistant messages only; undefined for user messages and for any message persisted before this field existed. Optionally shown in the UI (Settings toggle), off by default. */
  model?: string
}

interface MessageRow {
  id: string
  sessionId: string
  role: string
  content: string
  createdAt: number
  model: string | null
}

export function insertMessage(sessionId: string, role: 'user' | 'assistant', content: ContentBlock[], model?: string): MessageRecord {
  const now = Date.now()
  const id = randomUUID()
  const db = getDb()
  db.prepare('INSERT INTO messages (id, session_id, role, content, created_at, model) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    role,
    JSON.stringify(content),
    now,
    model ?? null
  )
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
  return { id, sessionId, role, content, createdAt: now, model }
}

export function listMessages(sessionId: string): MessageRecord[] {
  const rows = getDb()
    .prepare(
      'SELECT id, session_id AS sessionId, role, content, created_at AS createdAt, model FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    )
    .all(sessionId) as MessageRow[]

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as 'user' | 'assistant',
    content: JSON.parse(row.content) as ContentBlock[],
    createdAt: row.createdAt,
    model: row.model ?? undefined
  }))
}
