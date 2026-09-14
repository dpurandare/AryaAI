import { getDb } from '../db'
import { getSetting } from '../db/settings'
import { getApiKey } from '../security/keychain'
import { getEmbeddingProvider } from '../providers/setup'
import { extractSearchableText } from './extract-text'
import { chunkText } from './chunk-text'
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
function ensureChunkVectorTable(dimension: number): void {
  getDb().exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS message_chunk_vectors USING vec0(embedding float[${dimension}] distance_metric=cosine)`
  )
}

/**
 * Chunks one message's text (chunk-text.ts) and embeds+stores each chunk
 * separately, only if the resulting (provider, model) matches the index's
 * existing config (or this is the very first embed, which sets that
 * config). Returns false, without throwing, if a mismatch means this
 * message can't be indexed right now — the caller (backfill) just leaves
 * it for after a rebuild.
 *
 * Embeds *before* the bookkeeping insert, same ordering as the original
 * single-vector version — a thrown error here must leave no bookkeeping
 * row, so the next backfill pass retries the message, rather than
 * incorrectly marking it "handled" with nothing actually indexed.
 */
async function embedAndStoreChunks(
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

  const db = getDb()
  // Cheap pre-check, not itself the idempotency guarantee (a real
  // concurrent race between live indexing and backfill is still resolved
  // by the ON CONFLICT below — see drainQueue's doc comment) — just avoids
  // wasting an embed call on a message another in-flight job already
  // fully processed.
  if (db.prepare('SELECT 1 FROM message_embeddings WHERE message_id = ?').get(messageId)) {
    return true
  }

  const chunks = chunkText(text)
  const apiKey = getApiKey(providerId)
  const provider = getEmbeddingProvider(providerId, apiKey)
  const vectors = await provider.embed(chunks, model)

  const now = Date.now()
  if (!meta) {
    ensureChunkVectorTable(vectors[0].length)
    db.prepare(
      'INSERT INTO embedding_index_meta (id, provider_id, model, dimension, created_at) VALUES (1, ?, ?, ?, ?)'
    ).run(providerId, model, vectors[0].length, now)
  }

  const insertEmbedding = db.prepare(
    'INSERT INTO message_embeddings (message_id, session_id, model, created_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(message_id) DO NOTHING'
  )
  const result = insertEmbedding.run(messageId, sessionId, model, now)
  if (result.changes === 0) return true // lost a race to another job — don't double-insert chunks

  const insertChunk = db.prepare(
    'INSERT INTO message_chunks (message_id, session_id, chunk_text, created_at) VALUES (?, ?, ?, ?)'
  )
  const insertVector = db.prepare('INSERT INTO message_chunk_vectors(rowid, embedding) VALUES (?, ?)')
  for (let i = 0; i < chunks.length; i++) {
    const chunkResult = insertChunk.run(messageId, sessionId, chunks[i], now)
    insertVector.run(BigInt(chunkResult.lastInsertRowid), vectorToBuffer(vectors[i]))
  }
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
      await embedAndStoreChunks(messageId, sessionId, text, config.providerId, config.model)
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
          const ok = await embedAndStoreChunks(row.id, row.session_id, text, config.providerId, config.model)
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
  // message_vectors is the pre-chunking table — nothing reads it anymore,
  // this just cleans up the now-vestigial artifact for anyone who rebuilds
  // (a fresh install never creates it at all).
  db.exec('DROP TABLE IF EXISTS message_vectors')
  db.exec('DROP TABLE IF EXISTS message_chunk_vectors')
  db.exec('DELETE FROM message_chunks')
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
  chunk_text: string
  distance: number
}

/**
 * Cosine distance floor below which a chunk is treated as noise, not a real
 * match — KNN with no floor always pads out to `limit` with whatever's
 * next-closest once genuinely relevant chunks run out, however weak.
 * Found live, repeatedly, against the real default embedding model
 * (nomic-embed-text): a "tallest mountain" query's genuinely relevant hits
 * scored 0.67-0.89 (relevance = 1 - distance), while unrelated jump/
 * landing-speed content that still got returned (because `limit` wasn't
 * exhausted by good matches) scored only 0.42-0.48 — a clean, real gap.
 * 0.5 sits in that gap. Calibrated against this app's actual default
 * embedding model; may need retuning if a different one is configured and
 * produces a different score distribution — there's no cross-model
 * absolute-similarity standard to rely on instead.
 */
const MAX_DISTANCE = 0.5

/**
 * No longer excludes the calling session (see tool.ts's doc comment for
 * why) — a message from the current session can legitimately be the right
 * hit now that context/prepare-context.ts's sliding window can drop old
 * turns from a long-running session's own live context, leaving the model
 * with no other way back to them. The minor cost (an already-in-context
 * message occasionally also showing up in results) is harmless — the model
 * just sees something it already knows twice, not something wrong.
 *
 * Queries at chunk granularity (message_chunk_vectors/message_chunks), not
 * whole-message — `chunk_text` is stored directly on the chunk row, so a
 * hit is exactly the matched segment, not the whole original message
 * re-derived via extractSearchableText. Found live: a genuinely-authored
 * reply answering two unrelated topics in one message (e.g. "tallest
 * mountain discussed" + "horizontal speed for a landing") used to come
 * back in full for a query matching only one of them.
 *
 * Also applies MAX_DISTANCE (above) so a request for `limit` results
 * doesn't get padded with genuinely irrelevant chunks just because
 * `limit` wasn't otherwise satisfied — fewer, better results beat a full
 * quota diluted with noise.
 */
export async function searchIndex(query: string, limit: number): Promise<SearchHit[]> {
  const config = getEmbeddingConfig()
  const apiKey = getApiKey(config.providerId)
  const provider = getEmbeddingProvider(config.providerId, apiKey)
  const [queryVector] = await provider.embed([query], config.model)

  const overFetch = Math.min(limit * 4, 40)
  const rows = getDb()
    .prepare(
      `WITH knn AS (
         SELECT rowid, distance FROM message_chunk_vectors
         WHERE embedding MATCH ? AND k = ?
       )
       SELECT mc.message_id, mc.session_id, s.title, mc.created_at, mc.chunk_text, knn.distance
       FROM knn
       JOIN message_chunks mc ON mc.id = knn.rowid
       JOIN sessions s ON s.id = mc.session_id
       WHERE knn.distance <= ?
       ORDER BY knn.distance ASC
       LIMIT ?`
    )
    .all(vectorToBuffer(queryVector), overFetch, MAX_DISTANCE, limit) as SearchRow[]

  return rows.map((row) => ({
    messageId: row.message_id,
    sessionId: row.session_id,
    sessionTitle: row.title,
    createdAt: row.created_at,
    distance: row.distance,
    text: row.chunk_text
  }))
}
