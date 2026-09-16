import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import type { ToolContext } from './types'

// web-search.ts now imports security/keychain.ts (for the optional Tavily
// key), which imports `electron` at module scope and crashes outside a
// real Electron process — same hazard class documented throughout this
// project (e.g. data/connections.test.ts). Mock it here, not just import
// the real thing.
let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8')
  }
}))

const { setDbPath } = await import('../db')
const { setApiKey } = await import('../security/keychain')
const { webSearchTool } = await import('./web-search')

// web_search ignores ctx, but Tool.execute's signature requires one. A real
// OS-native path, not a hand-built one — see workspace-guard.test.ts.
const ctx: ToolContext = { workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-web-search-root')), currentSessionId: 'test-session' }

describe('web_search', () => {
  beforeEach(async () => {
    setDbPath(':memory:')
    userDataDir = await mkdtemp(join(tmpdir(), 'sachiv-web-search-'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('is never mutating', () => {
    expect(webSearchTool.mutates).toBe(false)
  })

  it('rejects an empty query', async () => {
    await expect(webSearchTool.execute({ query: '  ' }, ctx)).rejects.toThrow(/No query given/)
  })

  describe('no Tavily key configured — falls back to DuckDuckGo', () => {
    it('returns the abstract and source when present', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            Abstract: 'TypeScript is a typed superset of JavaScript.',
            AbstractURL: 'https://en.wikipedia.org/wiki/TypeScript',
            AbstractSource: 'Wikipedia',
            RelatedTopics: []
          }),
          { status: 200 }
        )
      )

      const result = await webSearchTool.execute({ query: 'typescript' }, ctx)
      expect(result).toContain('TypeScript is a typed superset of JavaScript.')
      expect(result).toContain('https://en.wikipedia.org/wiki/TypeScript')
      expect(result).toContain('Wikipedia')
    })

    it('returns an explicit no-result message when DuckDuckGo has nothing (verified live: common for real-world queries)', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Abstract: '', RelatedTopics: [] }), { status: 200 })
      )

      const result = await webSearchTool.execute({ query: 'who is the ceo of anthropic' }, ctx)
      expect(result).toMatch(/no instant answer found/)
    })

    it('includes related topics by text, but never their FirstURL — a DuckDuckGo internal category page, not a real fetchable source', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            Abstract: '',
            RelatedTopics: [{ Text: 'Related thing', FirstURL: 'https://duckduckgo.com/c/Related_thing' }]
          }),
          { status: 200 }
        )
      )

      const result = await webSearchTool.execute({ query: 'something' }, ctx)
      expect(result).toContain('Related thing')
      expect(result).not.toContain('duckduckgo.com/c/')
      expect(result).toContain('not fetchable')
    })

    it('flattens a disambiguation-style grouped RelatedTopics shape ({Name, Topics: [...]}) instead of missing it', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            Abstract: '',
            RelatedTopics: [
              { Name: 'Group A', Topics: [{ Text: 'Nested topic one', FirstURL: 'https://duckduckgo.com/c/A' }] },
              { Text: 'Flat topic', FirstURL: 'https://duckduckgo.com/c/B' }
            ]
          }),
          { status: 200 }
        )
      )

      const result = await webSearchTool.execute({ query: 'something' }, ctx)
      expect(result).toContain('Nested topic one')
      expect(result).toContain('Flat topic')
    })

    it('caps related topics at a reasonable count', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            Abstract: '',
            RelatedTopics: Array.from({ length: 20 }, (_, i) => ({ Text: `Topic ${i}`, FirstURL: `https://duckduckgo.com/c/${i}` }))
          }),
          { status: 200 }
        )
      )

      const result = await webSearchTool.execute({ query: 'something' }, ctx)
      const bulletLines = result.split('\n').filter((line) => line.startsWith('- '))
      expect(bulletLines.length).toBeLessThanOrEqual(8)
    })

    it('surfaces the matched Heading so the model can judge relevance — DuckDuckGo can confidently match the wrong sense of a query', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ Heading: 'PYTHON', Abstract: 'A Cold War-era UK nuclear programme.' }), { status: 200 })
      )

      const result = await webSearchTool.execute({ query: 'python' }, ctx)
      expect(result).toContain('Matched topic: PYTHON')
    })

    it('returns a Definition + DefinitionURL when present', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            Definition: 'A pleasant surprise.',
            DefinitionURL: 'https://www.merriam-webster.com/dictionary/serendipity',
            DefinitionSource: 'Merriam-Webster'
          }),
          { status: 200 }
        )
      )

      const result = await webSearchTool.execute({ query: 'serendipity' }, ctx)
      expect(result).toContain('A pleasant surprise.')
      expect(result).toContain('https://www.merriam-webster.com/dictionary/serendipity')
      expect(result).toContain('Merriam-Webster')
    })

    it('throws a clear error on a non-OK response', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('', { status: 500, statusText: 'Server Error' }))
      await expect(webSearchTool.execute({ query: 'x' }, ctx)).rejects.toThrow(/DuckDuckGo request failed/)
    })
  })

  describe('Tavily key configured — real search results', () => {
    beforeEach(() => {
      setApiKey('tavily', 'tvly-test-key')
    })

    it('calls the real Tavily endpoint with Bearer auth and the query', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [{ title: 'A real result', url: 'https://example.com/x', content: 'A real snippet.' }] }), {
          status: 200
        })
      )
      vi.stubGlobal('fetch', fetchMock)

      await webSearchTool.execute({ query: 'disha salian' }, ctx)

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tvly-test-key' })
        })
      )
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.query).toBe('disha salian')
      expect(body.topic).toBe('general')
    })

    it('passes topic: news through when requested — matters for the exact "latest on X" queries that kept failing', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      await webSearchTool.execute({ query: 'x', topic: 'news' }, ctx)

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.topic).toBe('news')
    })

    it('formats real results with title, URL, and snippet — genuinely fetchable sources, unlike the DuckDuckGo fallback', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { title: 'Real headline one', url: 'https://example.com/1', content: 'Snippet one.', published_date: '2026-09-15' },
              { title: 'Real headline two', url: 'https://example.com/2', content: 'Snippet two.' }
            ]
          }),
          { status: 200 }
        )
      )

      const result = await webSearchTool.execute({ query: 'x' }, ctx)
      expect(result).toContain('Real headline one: https://example.com/1 (2026-09-15)')
      expect(result).toContain('Snippet one.')
      expect(result).toContain('Real headline two: https://example.com/2')
      expect(result).toContain('Snippet two.')
    })

    it('respects a requested limit, capped at the max', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      await webSearchTool.execute({ query: 'x', limit: 999 }, ctx)

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.max_results).toBe(10)
    })

    it('reports plainly when Tavily has no results', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      const result = await webSearchTool.execute({ query: 'x' }, ctx)
      expect(result).toBe('(no results found for this query)')
    })

    it('throws a clear error on a non-OK Tavily response', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('bad key', { status: 401, statusText: 'Unauthorized' }))
      await expect(webSearchTool.execute({ query: 'x' }, ctx)).rejects.toThrow(/Tavily search failed: 401/)
    })

    it('never falls back to DuckDuckGo when a Tavily key is present, even on Tavily failure', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('', { status: 500, statusText: 'Server Error' }))
      await expect(webSearchTool.execute({ query: 'x' }, ctx)).rejects.toThrow(/Tavily/)
    })
  })
})
