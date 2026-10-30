import { beforeEach, describe, expect, it, vi } from 'vitest'

// indexer.ts calls getApiKey (security/keychain.ts), which imports `electron`
// at module scope — same hazard documented in tools/setup.test.ts.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sachiv-test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

// Deterministic fake vectors, keyed by exact text, so KNN ordering is
// predictable — real embedding providers are never called in these tests.
const VECTORS: Record<string, number[]> = {
  'revenue was 4.2 million': [1, 0, 0, 0],
  'revenue is now 5.1 million': [0.95, 0.1, 0, 0], // close to the above
  'the weather today is sunny': [0, 0, 1, 0], // unrelated
  query: [1, 0, 0, 0], // matches the first vector closely
  'Tallest mountain discussed:\nMount Everest is the tallest mountain.': [0, 1, 0, 0],
  'Horizontal speed for landing:\nYou need 15 ft/s to land 50 feet away.': [0, 0, 0, 1],
  'mountain question': [0, 1, 0, 0], // matches only the mountain half above
  // Reproduces the real observed gap: genuinely relevant hits scored
  // 0.67-0.89 relevance, unrelated content that still got returned (limit
  // wasn't exhausted by good matches) scored only 0.42-0.48. cos_sim([1,0],
  // [1,0])=1 (distance 0) and cos_sim([1,0],[1,0.3])≈0.958 (distance
  // ≈0.042) both land well inside the "relevant" band; cos_sim([1,0],
  // [1,2])≈0.447 (distance ≈0.553) lands just past the 0.5 floor, matching
  // the real irrelevant score almost exactly.
  'mountain query': [1, 0],
  'Mount Everest is the tallest mountain.': [1, 0],
  'The second-tallest mountain is K2.': [1, 0.3],
  'Vertical component at 45 degrees for a jump.': [1, 2]
}

vi.mock('../providers/setup', () => ({
  getEmbeddingProvider: vi.fn(() => ({
    id: 'fake',
    embed: vi.fn(async (texts: string[]) => texts.map((t) => VECTORS[t] ?? [0, 0, 0, 1]))
  }))
}))

const { setDbPath, getDb } = await import('../db')
const { setSetting, getSetting } = await import('../db/settings')
const { createSession } = await import('../db/sessions')
const { insertMessage } = await import('../db/messages')
const {
  enqueueMessage,
  runBackfill,
  rebuildIndex,
  verifyEmbeddingDigest,
  EMBEDDING_DIGEST_SETTING_KEY,
  getIndexState,
  getEmbeddingConfig,
  searchIndex,
  EMBEDDING_PROVIDER_SETTING_KEY,
  EMBEDDING_MODEL_SETTING_KEY
} = await import('./indexer')

describe('search-history indexer', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('defaults the embedding config to ollama/nomic-embed-text', () => {
    expect(getEmbeddingConfig()).toEqual({ providerId: 'ollama', model: 'nomic-embed-text' })
  })

  it('starts with an empty index state', () => {
    expect(getIndexState()).toEqual({ kind: 'empty' })
  })

  it('enqueueMessage indexes a message with searchable text', async () => {
    const session = createSession('S1')
    const message = insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    enqueueMessage(message.id, session.id, message.content)
    // enqueueMessage's drain loop is async but not awaited by the caller —
    // give it a tick to actually run before asserting.
    await new Promise((r) => setTimeout(r, 0))

    const state = getIndexState()
    expect(state).toEqual({ kind: 'ready', indexed: 1, total: 1 })
  })

  it('enqueueMessage skips a message with no searchable text (all tool_use)', async () => {
    const session = createSession('S1')
    const message = insertMessage(session.id, 'assistant', [
      { type: 'tool_use', id: 't1', name: 'search_history', input: {} }
    ])
    enqueueMessage(message.id, session.id, message.content)
    await new Promise((r) => setTimeout(r, 0))

    expect(getIndexState()).toEqual({ kind: 'empty' })
  })

  it('skips indexing a message whose text is too large to usefully embed, without ever calling the embedding provider (TASKS #172)', async () => {
    // Found live-adjacent to #171/#172: a DB query result is no longer capped at ~200 rows before
    // reaching here, so a real analytical result can be several MB — splitting that into
    // MAX_CHUNK_CHARS-sized chunks (#171) would still mean hundreds or thousands of embed() calls for
    // one message, which is both expensive and pointless (a raw structured-data dump has no real prose
    // semantics to search against). Asserts against `getEmbeddingProvider` itself (never overriding its
    // mocked return value) so this test can't leak a stale embed mock into any test that runs after it.
    const { getEmbeddingProvider } = await import('../providers/setup')
    vi.mocked(getEmbeddingProvider).mockClear()

    const session = createSession('S1')
    const huge = insertMessage(session.id, 'assistant', [{ type: 'text', text: 'x'.repeat(60_000) }])
    enqueueMessage(huge.id, session.id, huge.content)
    await new Promise((r) => setTimeout(r, 0))

    expect(getEmbeddingProvider).not.toHaveBeenCalled()
    expect(getIndexState()).toEqual({ kind: 'empty' }) // nothing indexable has ever been enqueued

    // runBackfill treats it the same way — marks it handled, never embeds it.
    await runBackfill()
    expect(getEmbeddingProvider).not.toHaveBeenCalled()
    expect(getDb().prepare('SELECT 1 FROM message_embeddings WHERE message_id = ?').get(huge.id)).toBeDefined()
  })

  it('runBackfill indexes pre-existing messages missing from the index, idempotently', async () => {
    const session = createSession('S1')
    insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    insertMessage(session.id, 'assistant', [{ type: 'text', text: 'revenue is now 5.1 million' }])

    await runBackfill()
    expect(getIndexState()).toEqual({ kind: 'ready', indexed: 2, total: 2 })

    await runBackfill() // second pass must not duplicate
    expect(getIndexState()).toEqual({ kind: 'ready', indexed: 2, total: 2 })
  })

  it('gives up on a message after repeated embed failures instead of retrying it forever (TASKS #171)', async () => {
    // Found live: a message whose embed call can never succeed (an oversized chunk crashing the local
    // embedding server, in the real incident) was retried every single backfill pass, forever — looping
    // the crash indefinitely. This caps that at a few attempts per message, per app run.
    const { getEmbeddingProvider } = await import('../providers/setup')
    const embedMock = vi.fn(async () => {
      throw new Error('boom')
    })
    const failingProvider = { id: 'fake', embed: embedMock }
    // mockReturnValueOnce (not a persistent mockReturnValue) so this override is fully consumed by this
    // test's own 3 attempts and never leaks into a later test in this file.
    vi.mocked(getEmbeddingProvider)
      .mockReturnValueOnce(failingProvider)
      .mockReturnValueOnce(failingProvider)
      .mockReturnValueOnce(failingProvider)

    const session = createSession('S1')
    const message = insertMessage(session.id, 'user', [{ type: 'text', text: 'a message that will never embed' }])

    await runBackfill() // internally retries this same message across its own batch passes until it gives up

    expect(embedMock).toHaveBeenCalledTimes(3)
    // Given up — marked as "indexed" with no vector, so it stops being selected by the backfill query.
    expect(getDb().prepare('SELECT 1 FROM message_embeddings WHERE message_id = ?').get(message.id)).toBeDefined()

    // A later pass must not try again.
    await runBackfill()
    expect(embedMock).toHaveBeenCalledTimes(3)
  })

  it("runBackfill skips a message whose session no longer exists, instead of crashing the whole pass — a real live bug: an orphaned message (session deleted without its FK cascade having applied, e.g. a cross-process race) crashed runBackfill on every single app start with a FOREIGN KEY constraint error, since nothing caught it before it propagated out", async () => {
    const liveSession = createSession('S1')
    insertMessage(liveSession.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    const doomedSession = createSession('S2 (about to be orphaned)')
    const orphan = insertMessage(doomedSession.id, 'assistant', [{ type: 'text', text: 'orphaned content' }])

    // Constructs the exact real-world state directly — a normal
    // deleteSession() call, with FK cascade honored within one connection,
    // would just clean this message up for real, not reproduce the bug.
    const db = getDb()
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM sessions WHERE id = ?').run(doomedSession.id)
    db.pragma('foreign_keys = ON')

    await expect(runBackfill()).resolves.not.toThrow()
    // The real, non-orphaned message still gets indexed — the orphan is
    // skipped, not fatal to the whole batch.
    expect(getIndexState()).toEqual({ kind: 'ready', indexed: 1, total: 2 })
    expect(db.prepare('SELECT 1 FROM message_embeddings WHERE message_id = ?').get(orphan.id)).toBeUndefined()
  })

  it('searchIndex finds the nearest match, ranked correctly, including a match from the calling session itself', async () => {
    const sessionA = createSession('Session A')
    const sessionB = createSession('Session B')
    const sessionC = createSession('Session C (current)')
    insertMessage(sessionA.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    insertMessage(sessionB.id, 'assistant', [{ type: 'text', text: 'the weather today is sunny' }])
    // No longer excluded (see indexer.ts's searchIndex doc comment) — a
    // long session's own sliding window can drop this exact message from
    // the model's live context, so it needs to be findable here too.
    insertMessage(sessionC.id, 'assistant', [{ type: 'text', text: 'revenue is now 5.1 million' }])

    await runBackfill()

    // Three candidates exist (KNN has no relevance threshold — that
    // judgment is left to the model via the `relevance` score); the
    // closest must rank first, and the current session's own message must
    // still appear somewhere in the results, not be silently dropped.
    const hits = await searchIndex('query', 5)
    expect(hits.map((h) => h.sessionId)).toContain(sessionC.id)
    expect(hits[0].sessionId).toBe(sessionA.id)
    expect(hits[0].text).toBe('revenue was 4.2 million')
  })

  it('a query matching only one topic of a composite two-topic message returns just that segment, not the whole message', async () => {
    // Found live: a genuinely-authored reply answering a compound question
    // ("tallest mountain discussed" + "horizontal speed for a landing")
    // was stored and embedded as one message — a later query matching only
    // the mountain half returned the landing-speed half too, since
    // retrieval operated at message granularity. Chunking on the blank
    // line between the two topics (chunk-text.ts) gives each its own
    // vector, so only the actually-relevant one comes back.
    const session = createSession('Compound answer')
    insertMessage(session.id, 'assistant', [
      {
        type: 'text',
        text:
          'Tallest mountain discussed:\nMount Everest is the tallest mountain.\n\n' +
          'Horizontal speed for landing:\nYou need 15 ft/s to land 50 feet away.'
      }
    ])
    await runBackfill()

    // limit=1: with the old one-vector-per-message scheme, this exact
    // message (however it happened to embed as a whole) was the only
    // candidate and always came back complete, landing-speed section
    // included. Chunking gives the two topics independent vectors, so the
    // closest (and only, at limit=1) result is exactly the relevant
    // segment — the unrelated topic doesn't ride along.
    const hits = await searchIndex('mountain question', 1)
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toBe('Tallest mountain discussed:\nMount Everest is the tallest mountain.')
    expect(hits[0].text).not.toContain('Horizontal speed')
  })

  it('a single-topic message (no blank lines) is still indexed and returned in full, unchanged', async () => {
    const session = createSession('S1')
    insertMessage(session.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    const hits = await searchIndex('query', 5)
    expect(hits[0].text).toBe('revenue was 4.2 million')
  })

  it('excludes a weakly-relevant match below the distance floor even when limit is not otherwise exhausted', async () => {
    // Found live, repeatedly: with no floor at all, KNN pads out to
    // `limit` with whatever's next-closest once genuinely relevant hits
    // run out, however weak — a "tallest mountain" query kept returning
    // unrelated jump/landing-speed content at 0.42-0.48 relevance. Here,
    // asking for limit=5 with only 2 genuinely relevant candidates and 1
    // weak one must return exactly the 2 relevant ones, not pad with the
    // third.
    const session = createSession('Mixed relevance')
    insertMessage(session.id, 'assistant', [{ type: 'text', text: 'Mount Everest is the tallest mountain.' }])
    insertMessage(session.id, 'assistant', [{ type: 'text', text: 'The second-tallest mountain is K2.' }])
    insertMessage(session.id, 'assistant', [{ type: 'text', text: 'Vertical component at 45 degrees for a jump.' }])
    await runBackfill()

    const hits = await searchIndex('mountain query', 5)
    expect(hits).toHaveLength(2)
    expect(hits.map((h) => h.text)).toEqual(
      expect.arrayContaining(['Mount Everest is the tallest mountain.', 'The second-tallest mountain is K2.'])
    )
    expect(hits.some((h) => h.text.includes('jump'))).toBe(false)
  })

  it('reports needs-rebuild when the configured model no longer matches the built index', async () => {
    const session = createSession('S1')
    insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()
    expect(getIndexState().kind).toBe('ready')

    setSetting(EMBEDDING_PROVIDER_SETTING_KEY, 'openai')
    setSetting(EMBEDDING_MODEL_SETTING_KEY, 'text-embedding-3-small')
    expect(getIndexState()).toEqual({ kind: 'needs-rebuild' })
  })

  it('rebuildIndex clears the old index and re-backfills under the new config', async () => {
    const session = createSession('S1')
    insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    setSetting(EMBEDDING_PROVIDER_SETTING_KEY, 'openai')
    setSetting(EMBEDDING_MODEL_SETTING_KEY, 'text-embedding-3-small')
    expect(getIndexState()).toEqual({ kind: 'needs-rebuild' })

    await rebuildIndex()
    expect(getIndexState()).toEqual({ kind: 'ready', indexed: 1, total: 1 })
  })

  // Placed last in this file deliberately: lastEmbedFailureReason is
  // process-wide module state (see indexer.ts), not reset by this file's
  // beforeEach (which only resets the DB). The final test below ends on a
  // successful embed, clearing it back out for anything that runs after
  // this file's tests in the same worker.
  describe("getIndexState's 'unavailable' state (a real failure never surfaced anywhere, found live)", () => {
    it('reports unavailable with the failure reason once an embed attempt fails and nothing has ever been indexed', async () => {
      // Found live: a fresh install with Ollama installed but
      // nomic-embed-text never pulled failed on every message forever,
      // completely silently — Settings showed "0 / 0 messages indexed",
      // identical to a fresh install that just hasn't sent a message yet.
      const { getEmbeddingProvider } = await import('../providers/setup')
      vi.mocked(getEmbeddingProvider).mockReturnValueOnce({
        id: 'fake',
        embed: vi.fn(async () => {
          throw new Error('model "nomic-embed-text" not found, try pulling it first')
        })
      })

      const session = createSession('S1')
      const message = insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
      enqueueMessage(message.id, session.id, message.content)
      await new Promise((r) => setTimeout(r, 0))

      expect(getIndexState()).toEqual({
        kind: 'unavailable',
        reason: 'model "nomic-embed-text" not found, try pulling it first'
      })
    })

    it('self-heals back to ready once a later embed attempt succeeds, with no extra plumbing needed', async () => {
      const { getEmbeddingProvider } = await import('../providers/setup')
      vi.mocked(getEmbeddingProvider).mockReturnValueOnce({
        id: 'fake',
        embed: vi.fn(async () => {
          throw new Error('boom')
        })
      })

      const session = createSession('S1')
      const failing = insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
      enqueueMessage(failing.id, session.id, failing.content)
      await new Promise((r) => setTimeout(r, 0))
      expect(getIndexState()).toEqual({ kind: 'unavailable', reason: 'boom' })

      const succeeding = insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue is now 5.1 million' }])
      enqueueMessage(succeeding.id, session.id, succeeding.content)
      await new Promise((r) => setTimeout(r, 0))
      expect(getIndexState()).toEqual({ kind: 'ready', indexed: 1, total: 2 })
    })
  })

  describe('embedding model digest guard (TASKS #224)', () => {
    async function withDigest(digest: string | undefined): Promise<void> {
      const { getEmbeddingProvider } = await import('../providers/setup')
      vi.mocked(getEmbeddingProvider).mockImplementation(
        () =>
          ({
            id: 'fake',
            embed: vi.fn(async (texts: string[]) => texts.map((t) => VECTORS[t] ?? [0, 0, 0, 1])),
            modelDigest: vi.fn(async () => digest)
          }) as never
      )
    }

    it('remembers the digest that built the index, flags a changed digest as needs-rebuild, and a rebuild clears it', async () => {
      await withDigest('sha-A')
      const session = createSession('S1')
      insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
      await runBackfill()
      expect(getSetting(EMBEDDING_DIGEST_SETTING_KEY)).toBe('sha-A')
      expect(getIndexState()).toEqual({ kind: 'ready', indexed: 1, total: 1 })

      await withDigest('sha-B') // reinstalled: same name, different weights
      await verifyEmbeddingDigest()
      expect(getIndexState()).toEqual({ kind: 'needs-rebuild', cause: 'model-changed' })

      // New messages are not added to the old index while the model differs.
      insertMessage(session.id, 'assistant', [{ type: 'text', text: 'revenue is now 5.1 million' }])
      await runBackfill()
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM message_embeddings').get()).toEqual({ n: 1 })

      await rebuildIndex()
      expect(getSetting(EMBEDDING_DIGEST_SETTING_KEY)).toBe('sha-B')
      expect(getIndexState()).toEqual({ kind: 'ready', indexed: 2, total: 2 })
    })

    it('adopts the current digest for an index built before the guard existed, and ignores an unknown digest', async () => {
      await withDigest(undefined)
      const session = createSession('S1')
      insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
      await runBackfill()
      expect(getSetting(EMBEDDING_DIGEST_SETTING_KEY)).toBe('')
      await verifyEmbeddingDigest() // server cannot report one: nothing changes
      expect(getIndexState()).toEqual({ kind: 'ready', indexed: 1, total: 1 })

      await withDigest('sha-A')
      await verifyEmbeddingDigest()
      expect(getSetting(EMBEDDING_DIGEST_SETTING_KEY)).toBe('sha-A')
      expect(getIndexState()).toEqual({ kind: 'ready', indexed: 1, total: 1 })
    })
  })
})
