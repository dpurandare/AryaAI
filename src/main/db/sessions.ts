import { randomUUID } from 'node:crypto'
import { getDb } from './index'

export interface SessionRecord {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export function createSession(title: string): SessionRecord {
  const now = Date.now()
  const session: SessionRecord = { id: randomUUID(), title, createdAt: now, updatedAt: now }
  getDb()
    .prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (@id, @title, @createdAt, @updatedAt)')
    .run(session)
  return session
}

export function listSessions(): SessionRecord[] {
  const rows = getDb()
    .prepare('SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC')
    .all()
  return rows as SessionRecord[]
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}
