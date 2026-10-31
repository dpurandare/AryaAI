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
  embeddingServerSettled: vi.fn(() => true),
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

  it('returns tagged results from another session', async () => {
    const other = createSession('Q2 numbers')
    const current = createSession('S current')
    insertMessage(other.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result).toContain('<historical_result')
    expect(result).toContain('session="Q2 numbers"')
    expect(result).toContain('revenue was 4.2 million')
  })

  it('also finds a match in the current session, not just other sessions', async () => {
    // Deliberately does NOT exclude the calling session anymore — a long
    // session's own sliding window can drop old turns from the model's
    // live context (context/prepare-context.ts), and this is the only way
    // back to them for the rest of that same conversation.
    const current = createSession('S current')
    insertMessage(current.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result).toContain('<historical_result')
    expect(result).toContain('revenue was 4.2 million')
  })

  it('does not return the message that started this turn as a match for itself (0.4.0 test 214-8)', async () => {
    const current = createSession('S current')
    // The user's request is saved and indexed before the tool runs; its text is the query.
    insertMessage(current.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result).toContain('no relevant past conversations')
    expect(result).not.toContain('<historical_result')
  })

  it('still finds an EARLIER user message of the same session, and ignores tool results when picking the current one', async () => {
    const current = createSession('S current')
    insertMessage(current.id, 'user', [{ type: 'text', text: 'revenue was 4.2 million' }])
    insertMessage(current.id, 'assistant', [{ type: 'text', text: 'noted' }])
    insertMessage(current.id, 'user', [{ type: 'text', text: 'what did I say about sales?' }])
    insertMessage(current.id, 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'x' }])
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result).toContain('revenue was 4.2 million')
    expect(result).not.toContain('what did I say about sales?')
  })

  it('names the matching sessions up front and extends a very short hit with what follows it (0.4.0 test 214-8)', async () => {
    const other = createSession('Essay on Europe')
    insertMessage(other.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million\n\nThe second paragraph says more about the same thing and goes on for a while.' }])
    const current = createSession('S current')
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result).toContain('Matches come from 1 past session: "Essay on Europe"')
    expect(result).toContain('The second paragraph says more')
  })

  it('shows the same text found twice in one session only once', async () => {
    const other = createSession('Essay on Europe')
    insertMessage(other.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    insertMessage(other.id, 'assistant', [{ type: 'text', text: 'revenue was 4.2 million' }])
    const current = createSession('S current')
    await runBackfill()

    const result = await searchHistoryTool.execute({ query: 'query' }, ctxFor(current.id))
    expect(result.match(/<historical_result/g)).toHaveLength(1)
  })

  it('throws on an empty query', async () => {
    const session = createSession('S1')
    await expect(searchHistoryTool.execute({ query: '  ' }, ctxFor(session.id))).rejects.toThrow('No query given.')
  })
})
