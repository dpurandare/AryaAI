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
  query: [1, 0, 0, 0] // matches the first vector closely
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

  it('searchIndex finds the nearest match and excludes the current session', async () => {
    const sessionA = createSession('Session A')
    const sessionB = createSession('Session B')
    const sessionC = createSession('Session C (current)')
    insertMessage(sessionA.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    insertMessage(sessionB.id, 'assistant', [{ type: 'text', text: 'the weather today is sunny' }])
    // A near-duplicate in the *current* session should never come back.
    insertMessage(sessionC.id, 'assistant', [{ type: 'text', text: 'revenue is now 5.1 million' }])

    await runBackfill()

    // Two other-session candidates exist, so both come back (KNN has no
    // relevance threshold — that judgment is left to the model via the
    // `relevance` score) — but the closer one must rank first, and the
    // current session's near-duplicate must never appear at all.
    const hits = await searchIndex('query', sessionC.id, 5)
    expect(hits.map((h) => h.sessionId)).not.toContain(sessionC.id)
    expect(hits[0].sessionId).toBe(sessionA.id)
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
