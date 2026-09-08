import { beforeEach, describe, expect, it, vi } from 'vitest'

// tool.ts -> indexer.ts / getApiKey (keychain.ts) imports `electron` at
// module scope — same hazard documented in tools/setup.test.ts.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sachiv-test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const VECTORS: Record<string, number[]> = {
  'revenue was 4.2 million': [1, 0, 0, 0],
  query: [1, 0, 0, 0]
}

let embedShouldFail = false

vi.mock('../providers/setup', () => ({
  getEmbeddingProvider: vi.fn(() => ({
    id: 'fake',
    embed: vi.fn(async (texts: string[]) => {
      if (embedShouldFail) throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      return texts.map((t) => VECTORS[t] ?? [0, 0, 0, 1])
    })
  }))
}))

const { setDbPath } = await import('../db')
const { setSetting } = await import('../db/settings')
const { createSession } = await import('../db/sessions')
const { insertMessage } = await import('../db/messages')
const { runBackfill, EMBEDDING_PROVIDER_SETTING_KEY, EMBEDDING_MODEL_SETTING_KEY } = await import('./indexer')
const { searchHistoryTool } = await import('./tool')

function ctxFor(sessionId: string) {
  return { workspaceGuard: {} as never, currentSessionId: sessionId }
}

describe('search_history tool', () => {
  beforeEach(() => {
    setDbPath(':memory:')
    embedShouldFail = false
  })

  it('reports "still building" when nothing is indexed yet but the provider is reachable', async () => {
    const session = createSession('S1')
    const result = await searchHistoryTool.execute({ query: 'revenue' }, ctxFor(session.id))
    expect(result).toContain('still building')
  })

  it('reports the provider is not reachable when embed() fails and nothing is indexed', async () => {
    embedShouldFail = true
    const session = createSession('S1')
    const result = await searchHistoryTool.execute({ query: 'revenue' }, ctxFor(session.id))
    expect(result).toContain("isn't reachable")
    expect(result).toContain('ECONNREFUSED')
  })

  it('reports needs-rebuild when the configured model no longer matches the index', async () => {
    const session = createSession('S1')
    insertMessage(session.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    setSetting(EMBEDDING_PROVIDER_SETTING_KEY, 'openai')
    setSetting(EMBEDDING_MODEL_SETTING_KEY, 'text-embedding-3-small')

    const result = await searchHistoryTool.execute({ query: 'revenue' }, ctxFor(session.id))
    expect(result).toContain('rebuilt')
  })

  it('returns tagged results excluding the current session', async () => {
    const other = createSession('Q2 numbers')
    const current = createSession('S current')
    insertMessage(other.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result).toContain('<historical_result')
    expect(result).toContain('session="Q2 numbers"')
    expect(result).toContain('revenue was 4.2 million')
  })

  it('reports no results found when the only match is in the current session', async () => {
    const current = createSession('S current')
    insertMessage(current.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result).toBe('(no relevant past conversations found for that query.)')
  })

  it('throws on an empty query', async () => {
    const session = createSession('S1')
    await expect(searchHistoryTool.execute({ query: '  ' }, ctxFor(session.id))).rejects.toThrow('No query given.')
  })
})
