import { getDb } from '../db'
import { getSetting, setSetting } from '../db/settings'
import { getApiKey } from '../security/keychain'
import { getEmbeddingProvider } from '../providers/setup'
import { extractSearchableText } from './extract-text'
import { chunkText } from './chunk-text'
import type { ContentBlock } from '@shared/protocol'

export const EMBEDDING_PROVIDER_SETTING_KEY = 'embeddingProviderId'
export const EMBEDDING_MODEL_SETTING_KEY = 'embeddingModel'
/** TASKS #224: the digest of the embedding model's weights when the index was built (empty/absent = unknown). No schema change: app_settings is a flat key-value table. */
export const EMBEDDING_DIGEST_SETTING_KEY = 'embeddingIndexDigest'

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
  | { kind: 'needs-rebuild'; cause?: 'model-changed' }
  | { kind: 'unavailable'; reason: string }

/**
 * The most recent embed attempt's outcome, recorded by `recordEmbedFailure`/
 * `recordEmbedSuccess` below — used only to distinguish "never indexed
 * anything because nothing's been sent yet" from "never indexed anything
 * because every attempt has failed" in `getIndexState`'s 'unavailable'
 * state. Found live: a fresh install with Ollama installed but
 * `nomic-embed-text` never pulled failed on every single message, forever,
 * completely silently — `enqueueMessage`/`runBackfill` only `console.error`
 * it (invisible outside a dev terminal), and `IndexState` had no failure
 * variant at all, so Settings showed "0 / 0 messages indexed" — identical
 * to a fresh install that just hasn't sent a message yet. Cleared on the
 * next success rather than only ever growing stale, so switching to a
 * working model/provider self-heals this without any extra plumbing.
 */
let lastEmbedFailureReason: string | undefined

function recordEmbedFailure(err: unknown): void {
  lastEmbedFailureReason = err instanceof Error ? err.message : String(err)
}

function recordEmbedSuccess(): void {
  lastEmbedFailureReason = undefined
}

/**
 * TASKS #224: set when the model behind the configured name is no longer the one that built the index (a
 * reinstall or another Ollama pulled different weights under the same name). Vectors from the two would not
 * be comparable, so nothing new is added to the index and search asks for a rebuild instead of degrading silently.
 */
let digestMismatch = false
let lastDigestCheckAt = 0
const DIGEST_RECHECK_MS = 5 * 60_000

/**
 * Compares the digest the embedding server reports now with the one stored when the index was built. Adopts the
 * current digest when none is stored yet (an index built before #224: the best available assumption). Best effort:
 * an unreachable server or a provider that cannot report a digest changes nothing. Never throws.
 */
export async function verifyEmbeddingDigest(): Promise<void> {
  try {
    const meta = getIndexMeta()
    const config = getEmbeddingConfig()
    if (!meta || meta.provider_id !== config.providerId || meta.model !== config.model) return
    const provider = getEmbeddingProvider(config.providerId, getApiKey(config.providerId))
    const current = await provider.modelDigest?.(config.model)
    if (!current) return
    lastDigestCheckAt = Date.now()
    const stored = getSetting(EMBEDDING_DIGEST_SETTING_KEY)
    if (!stored) {
      setSetting(EMBEDDING_DIGEST_SETTING_KEY, current)
      digestMismatch = false
    } else {
      digestMismatch = stored !== current
    }
  } catch {
    // keep the previous verdict
  }
}

export function getIndexState(): IndexState {
  const meta = getIndexMeta()
  const config = getEmbeddingConfig()
  if (!meta) {
    return lastEmbedFailureReason ? { kind: 'unavailable', reason: lastEmbedFailureReason } : { kind: 'empty' }
  }
  if (meta.provider_id !== config.providerId || meta.model !== config.model) {
    return { kind: 'needs-rebuild' }
  }
  if (digestMismatch) return { kind: 'needs-rebuild', cause: 'model-changed' }
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
  if (meta && Date.now() - lastDigestCheckAt > DIGEST_RECHECK_MS) await verifyEmbeddingDigest()
  if (meta && digestMismatch) return false

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
  recordEmbedSuccess()

  const now = Date.now()
  if (!meta) {
    ensureChunkVectorTable(vectors[0].length)
    db.prepare(
      'INSERT INTO embedding_index_meta (id, provider_id, model, dimension, created_at) VALUES (1, ?, ?, ?, ?)'
    ).run(providerId, model, vectors[0].length, now)
    // #224: remember which weights built this index (best effort; unknown stays unknown).
    const digest = await provider.modelDigest?.(model).catch(() => undefined)
    setSetting(EMBEDDING_DIGEST_SETTING_KEY, digest ?? '')
    digestMismatch = false
    lastDigestCheckAt = Date.now()
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

/**
 * TASKS.md #172/#171: a tool_result's text is no longer capped at ~200 rows before it reaches here
 * (see `MAX_SAFETY_ROWS`, each `*-driver.ts`) — a real analytical query result can now be several MB.
 * `chunkText`'s own `MAX_CHUNK_CHARS` cap (#171) keeps any individual chunk safe to embed, but a message
 * this large would still split into hundreds or thousands of chunks, each its own `embed()` call — a
 * real cost/latency problem, and pointless besides: a multi-MB raw structured-data dump has no
 * meaningful prose semantics for "search my past conversations" to match against in the first place.
 * Skipped the same way a message with no searchable text already is — this is not a failure, just
 * nothing worth indexing.
 */
const MAX_INDEXABLE_CHARS = 50_000

function isTooLargeToIndex(text: string): boolean {
  return text.length > MAX_INDEXABLE_CHARS
}

export function enqueueMessage(messageId: string, sessionId: string, content: ContentBlock[]): void {
  const text = extractSearchableText(content)
  if (!text || isTooLargeToIndex(text)) return
  pendingJobs.push(async () => {
    const config = getEmbeddingConfig()
    try {
      await embedAndStoreChunks(messageId, sessionId, text, config.providerId, config.model)
    } catch (err) {
      recordEmbedFailure(err)
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

/**
 * TASKS.md #171: a message that can never successfully embed (every attempt throws) used to be
 * retried every single backfill pass, forever — found live, this kept crashing the local Ollama
 * embedding server in a tight loop (the oversized-chunk segfault `chunk-text.ts`'s own `MAX_CHUNK_CHARS`
 * now prevents, but any other persistent embed failure would hit the identical infinite-retry shape).
 * Counted in memory, not persisted — reset on every app restart, so this is a bound on retries *within
 * one running process*, not a permanent record; a message that starts failing, stops, then starts again
 * after a restart just gets its own fresh 3 attempts, which is fine — the goal is only to stop one bad
 * message from looping forever in a single session, not to never look at it again.
 */
const MAX_EMBED_FAILURES_PER_MESSAGE = 3
const embedFailureCounts = new Map<string, number>()

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
           JOIN sessions s ON s.id = m.session_id
           WHERE me.id IS NULL
           ORDER BY m.created_at ASC
           LIMIT ?`
        )
        .all(BACKFILL_BATCH_SIZE) as UnindexedMessageRow[]

      if (rows.length === 0) return

      for (const row of rows) {
        const content = JSON.parse(row.content) as ContentBlock[]
        const text = extractSearchableText(content)
        if (!text || isTooLargeToIndex(text)) {
          // Nothing to embed (e.g. all tool_use, or too large to usefully index — see
          // isTooLargeToIndex) — mark as "indexed" with no vector so backfill doesn't retry it forever.
          // Wrapped like the real embed path below (not left bare like it
          // used to be) — a real, live failure here (FOREIGN KEY constraint
          // failed, from a handful of orphaned messages left over from an
          // abnormal multi-process race, not normal operation) crashed the
          // *entire* backfill loop on every single app start, since nothing
          // caught it before it propagated out of runBackfill entirely.
          try {
            getDb()
              .prepare(
                'INSERT INTO message_embeddings (message_id, session_id, model, created_at) VALUES (?, ?, ?, ?) ' +
                  'ON CONFLICT(message_id) DO NOTHING'
              )
              .run(row.id, row.session_id, config.model, Date.now())
          } catch (err) {
            console.error(`search_history: backfill failed for message ${row.id}:`, err)
          }
          continue
        }
        try {
          const ok = await embedAndStoreChunks(row.id, row.session_id, text, config.providerId, config.model)
          if (!ok) return // config changed mid-backfill — stop, needs rebuild
          embedFailureCounts.delete(row.id)
        } catch (err) {
          recordEmbedFailure(err)
          console.error(`search_history: backfill failed for message ${row.id}:`, err)
          const failures = (embedFailureCounts.get(row.id) ?? 0) + 1
          if (failures < MAX_EMBED_FAILURES_PER_MESSAGE) {
            embedFailureCounts.set(row.id, failures)
            // Leave it un-indexed; the next backfill pass will retry it.
          } else {
            // Given up on this message for the rest of this process's lifetime — same "indexed with no
            // vector" bookkeeping the no-searchable-text case above uses, so it stops being selected by
            // this loop's own query instead of being retried forever.
            console.error(`search_history: giving up on message ${row.id} after ${failures} failed embed attempts`)
            embedFailureCounts.delete(row.id)
            try {
              getDb()
                .prepare(
                  'INSERT INTO message_embeddings (message_id, session_id, model, created_at) VALUES (?, ?, ?, ?) ' +
                    'ON CONFLICT(message_id) DO NOTHING'
                )
                .run(row.id, row.session_id, config.model, Date.now())
            } catch (giveUpErr) {
              console.error(`search_history: failed to mark message ${row.id} as given-up:`, giveUpErr)
            }
          }
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
  setSetting(EMBEDDING_DIGEST_SETTING_KEY, '')
  digestMismatch = false
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
