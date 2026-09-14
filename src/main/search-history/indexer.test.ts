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
  'mountain question': [0, 1, 0, 0] // matches only the mountain half above
}

vi.mock('../providers/setup', () => ({
  getEmbeddingProvider: vi.fn(() => ({
    id: 'fake',
    embed: vi.fn(async (texts: string[]) => texts.map((t) => VECTORS[t] ?? [0, 0, 0, 1]))
  }))
}))

const { setDbPath } = await import('../db')
const { setSetting } = await import('../db/settings')
const { createSession } = await import('../db/sessions')
const { insertMessage } = await import('../db/messages')
const {
  enqueueMessage,
  runBackfill,
  rebuildIndex,
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

  it('runBackfill indexes pre-existing messages missing from the index, idempotently', async () => {
    const session = createSession('S1')
    insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    insertMessage(session.id, 'assistant', [{ type: 'text', text: 'revenue is now 5.1 million' }])

    await runBackfill()
    expect(getIndexState()).toEqual({ kind: 'ready', indexed: 2, total: 2 })

    await runBackfill() // second pass must not duplicate
    expect(getIndexState()).toEqual({ kind: 'ready', indexed: 2, total: 2 })
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
})
