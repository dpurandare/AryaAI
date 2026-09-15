import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { webSearchTool } from './web-search'
import type { ToolContext } from './types'

// web_search ignores ctx, but Tool.execute's signature requires one. A real
// OS-native path, not a hand-built one — see workspace-guard.test.ts.
const ctx: ToolContext = { workspaceGuard: new WorkspaceGuard(resolve(tmpdir(), 'sachiv-web-search-root')), currentSessionId: 'test-session' }

describe('web_search', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is never mutating', () => {
    expect(webSearchTool.mutates).toBe(false)
  })

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

  it('rejects an empty query', async () => {
    await expect(webSearchTool.execute({ query: '  ' }, ctx)).rejects.toThrow(/No query given/)
  })
})
