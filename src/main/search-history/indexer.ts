import { getDb } from '../db'
import { getSetting } from '../db/settings'
import { getApiKey } from '../security/keychain'
import { getEmbeddingProvider } from '../providers/setup'
import { extractSearchableText } from './extract-text'
import type { ContentBlock } from '@shared/protocol'

export const EMBEDDING_PROVIDER_SETTING_KEY = 'embeddingProviderId'
export const EMBEDDING_MODEL_SETTING_KEY = 'embeddingModel'

// Ollama, local, no API key, no setup — works out of the box.
const DEFAULT_EMBEDDING_PROVIDER_ID = 'ollama'
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'

const BACKFILL_BATCH_SIZE = 20
const BACKFILL_BATCH_DELAY_MS = 500

interface EmbeddingConfig {
  providerId: string
  model: string
}

export function getEmbeddingConfig(): EmbeddingConfig {
  return {
    providerId: getSetting(EMBEDDING_PROVIDER_SETTING_KEY) ?? DEFAULT_EMBEDDING_PROVIDER_ID,
    model: getSetting(EMBEDDING_MODEL_SETTING_KEY) ?? DEFAULT_EMBEDDING_MODEL
  }
}

interface IndexMetaRow {
  provider_id: string
  model: string
  dimension: number
}

function getIndexMeta(): IndexMetaRow | undefined {
  return getDb().prepare('SELECT provider_id, model, dimension FROM embedding_index_meta WHERE id = 1').get() as
    | IndexMetaRow
    | undefined
}

/**
 * Whether the *configured* embedding (provider, model) matches what the
 * index was actually built with. `null` meta means nothing has been indexed
 * yet (fresh install / empty index) — a different state from a genuine
 * mismatch (the user changed the config after some indexing already happened).
 */
export type IndexState =
  | { kind: 'empty' }
  | { kind: 'ready'; indexed: number; total: number }
  | { kind: 'needs-rebuild' }

export function getIndexState(): IndexState {
  const meta = getIndexMeta()
  const config = getEmbeddingConfig()
  if (!meta) return { kind: 'empty' }
  if (meta.provider_id !== config.providerId || meta.model !== config.model) {
    return { kind: 'needs-rebuild' }
  }
  const { indexed } = getDb().prepare('SELECT COUNT(*) AS indexed FROM message_embeddings').get() as {
    indexed: number
  }
  const { total } = getDb().prepare('SELECT COUNT(*) AS total FROM messages').get() as { total: number }
  return { kind: 'ready', indexed, total }
}

function vectorToBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

/** vec0 tables need their rowid passed as a BigInt via better-sqlite3, not a plain number — confirmed empirically. */
function ensureVectorTable(dimension: number): void {
  getDb().exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors USING vec0(embedding float[${dimension}] distance_metric=cosine)`
  )
}

/**
 * Embeds one message's text and stores it, only if the resulting (provider,
 * model) matches the index's existing config (or this is the very first
 * embed, which sets that config). Returns false, without throwing, if a
 * mismatch means this message can't be indexed right now — the caller
 * (backfill) just leaves it for after a rebuild.
 */
async function embedAndStore(
  messageId: string,
  sessionId: string,
  text: string,
  providerId: string,
  model: string
): Promise<boolean> {
  const meta = getIndexMeta()
  if (meta && (meta.provider_id !== providerId || meta.model !== model)) {
    return false
  }

  const apiKey = getApiKey(providerId)
  const provider = getEmbeddingProvider(providerId, apiKey)
  const [vector] = await provider.embed([text], model)

  const db = getDb()
  const now = Date.now()

  if (!meta) {
    ensureVectorTable(vector.length)
    db.prepare(
      'INSERT INTO embedding_index_meta (id, provider_id, model, dimension, created_at) VALUES (1, ?, ?, ?, ?)'
    ).run(providerId, model, vector.length, now)
  }

  const insertEmbedding = db.prepare(
    'INSERT INTO message_embeddings (message_id, session_id, model, created_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(message_id) DO NOTHING'
  )
  const result = insertEmbedding.run(messageId, sessionId, model, now)
  if (result.changes === 0) return true // already indexed (idempotent re-run)

  db.prepare('INSERT INTO message_vectors(rowid, embedding) VALUES (?, ?)').run(
    BigInt(result.lastInsertRowid),
    vectorToBuffer(vector)
  )
  return true
}

// --- Fire-and-forget in-process queue, used after each new message ---
// A plain array of pending jobs, drained one at a time — no new job-queue
// dependency. Never blocks the caller (the chat response); a failed embed
// is logged and dropped, naturally retried by the next backfill pass since
// the message stays missing from message_embeddings.

const pendingJobs: (() => Promise<void>)[] = []
let draining = false

export function enqueueMessage(messageId: string, sessionId: string, content: ContentBlock[]): void {
  const text = extractSearchableText(content)
  if (!text) return
  pendingJobs.push(async () => {
    const config = getEmbeddingConfig()
    try {
      await embedAndStore(messageId, sessionId, text, config.providerId, config.model)
    } catch (err) {
      console.error(`search_history: failed to index message ${messageId}:`, err)
    }
  })
  void drainQueue()
}

async function drainQueue(): Promise<void> {
  if (draining) return
  draining = true
  try {
    let job: (() => Promise<void>) | undefined
    while ((job = pendingJobs.shift())) {
      await job()
    }
  } finally {
    draining = false
  }
}

// --- Startup / on-demand backfill for pre-existing messages ---

let backfillRunning = false

interface UnindexedMessageRow {
  id: string
  session_id: string
  content: string
}

export async function runBackfill(): Promise<void> {
  if (backfillRunning) return
  backfillRunning = true
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const config = getEmbeddingConfig()
      const meta = getIndexMeta()
      if (meta && (meta.provider_id !== config.providerId || meta.model !== config.model)) {
        // Needs an explicit rebuild before backfill can continue — see indexer's IndexState.
        return
      }

      const rows = getDb()
        .prepare(
          `SELECT m.id, m.session_id, m.content FROM messages m
           LEFT JOIN message_embeddings me ON me.message_id = m.id
           WHERE me.id IS NULL
           ORDER BY m.created_at ASC
           LIMIT ?`
        )
        .all(BACKFILL_BATCH_SIZE) as UnindexedMessageRow[]

      if (rows.length === 0) return

      for (const row of rows) {
        const content = JSON.parse(row.content) as ContentBlock[]
        const text = extractSearchableText(content)
        if (!text) {
          // Nothing to embed (e.g. all tool_use) — mark as "indexed" with no
          // vector so backfill doesn't retry it forever. A message with no
          // searchable text can never usefully match a search anyway.
          getDb()
            .prepare(
              'INSERT INTO message_embeddings (message_id, session_id, model, created_at) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT(message_id) DO NOTHING'
            )
            .run(row.id, row.session_id, config.model, Date.now())
          continue
        }
        try {
          const ok = await embedAndStore(row.id, row.session_id, text, config.providerId, config.model)
          if (!ok) return // config changed mid-backfill — stop, needs rebuild
        } catch (err) {
          console.error(`search_history: backfill failed for message ${row.id}:`, err)
          // Leave it un-indexed; the next backfill pass will retry it.
        }
      }

      await new Promise((resolve) => setTimeout(resolve, BACKFILL_BATCH_DELAY_MS))
    }
  } finally {
    backfillRunning = false
  }
}

export async function rebuildIndex(): Promise<void> {
  const db = getDb()
  db.exec('DROP TABLE IF EXISTS message_vectors')
  db.exec('DELETE FROM message_embeddings')
  db.exec('DELETE FROM embedding_index_meta')
  await runBackfill()
}

// --- Search ---

export interface SearchHit {
  messageId: string
  sessionId: string
  sessionTitle: string
  createdAt: number
  distance: number
  text: string
}

interface SearchRow {
  message_id: string
  session_id: string
  title: string
  created_at: number
  content: string
  distance: number
}

export async function searchIndex(query: string, excludeSessionId: string, limit: number): Promise<SearchHit[]> {
  const config = getEmbeddingConfig()
  const apiKey = getApiKey(config.providerId)
  const provider = getEmbeddingProvider(config.providerId, apiKey)
  const [queryVector] = await provider.embed([query], config.model)

  const overFetch = Math.min(limit * 4, 40)
  const rows = getDb()
    .prepare(
      `WITH knn AS (
         SELECT rowid, distance FROM message_vectors
         WHERE embedding MATCH ? AND k = ?
       )
       SELECT me.message_id, me.session_id, s.title, m.created_at, m.content, knn.distance
       FROM knn
       JOIN message_embeddings me ON me.id = knn.rowid
       JOIN messages m ON m.id = me.message_id
       JOIN sessions s ON s.id = me.session_id
       WHERE me.session_id != ?
       ORDER BY knn.distance ASC
       LIMIT ?`
    )
    .all(vectorToBuffer(queryVector), overFetch, excludeSessionId, limit) as SearchRow[]

  return rows.map((row) => ({
    messageId: row.message_id,
    sessionId: row.session_id,
    sessionTitle: row.title,
    createdAt: row.created_at,
    distance: row.distance,
    text: extractSearchableText(JSON.parse(row.content) as ContentBlock[])
  }))
}
