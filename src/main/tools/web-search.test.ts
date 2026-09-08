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

  it('includes related topics when present', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          Abstract: '',
          RelatedTopics: [{ Text: 'Related thing', FirstURL: 'https://example.com' }]
        }),
        { status: 200 }
      )
    )

    const result = await webSearchTool.execute({ query: 'something' }, ctx)
    expect(result).toContain('Related thing')
    expect(result).toContain('https://example.com')
  })

  it('throws a clear error on a non-OK response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 500, statusText: 'Server Error' }))
    await expect(webSearchTool.execute({ query: 'x' }, ctx)).rejects.toThrow(/DuckDuckGo request failed/)
  })

  it('rejects an empty query', async () => {
    await expect(webSearchTool.execute({ query: '  ' }, ctx)).rejects.toThrow(/No query given/)
  })
})
