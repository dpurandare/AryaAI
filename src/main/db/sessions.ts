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

/**
 * `messages`/`session_usage`/`message_embeddings` all cascade away on their
 * own (ON DELETE CASCADE + `foreign_keys = ON`, see db/index.ts). One thing
 * doesn't: `message_vectors`, sqlite-vec's vec0 virtual table pairing a
 * `message_embeddings.id` to its actual vector — it's created lazily in
 * code (search-history/indexer.ts), not declared in schema.sql, and a
 * virtual table can't be the target of a real FK constraint, so SQLite has
 * no way to cascade into it. Left alone, every deleted session's vectors
 * become permanent orphans: harmless to search_history's *correctness*
 * (its query inner-joins message_vectors back to message_embeddings, so an
 * orphaned rowid can never surface as a result) but not to its *quality* —
 * they still occupy slots in the raw KNN scan before that join filters
 * them out, so enough accumulated orphans can crowd real results out of
 * the top-K window. Confirmed live against the real app db: rowids stayed
 * in message_vectors indefinitely after their session, messages, and
 * message_embeddings rows were all correctly gone.
 *
 * Deletes by subquery, not a fetch-then-loop — a rowid used this way
 * doesn't need the BigInt coercion `indexer.ts`'s ensureVectorTable needs
 * for *inserting* a specific rowid (confirmed empirically against the real
 * vec0 table before writing this); no JS-supplied integer parameter
 * crosses the boundary here at all.
 *
 * `message_vectors` may not exist yet (fresh install, nothing embedded
 * ever) — guarded rather than assumed, since search-history/indexer.ts
 * only creates it lazily on the first real embed.
 */
export function deleteSession(id: string): void {
  const db = getDb()
  const deleteSessionAndVectors = db.transaction((sessionId: string) => {
    const vectorTableExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_vectors'")
      .get()
    if (vectorTableExists) {
      db.prepare(
        'DELETE FROM message_vectors WHERE rowid IN (SELECT id FROM message_embeddings WHERE session_id = ?)'
      ).run(sessionId)
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  })
  deleteSessionAndVectors(id)
}
