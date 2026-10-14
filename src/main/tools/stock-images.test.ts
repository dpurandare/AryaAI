import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../security/workspace-guard'
import { checkUrlAllowed } from './data-formats/link-registry'
import { findStockImagesTool, licenceLabel } from './stock-images'
import type { ToolContext } from './types'

const result = (over: Record<string, unknown> = {}) => ({
  title: 'Team meeting in a bright office',
  url: 'https://cdn.stocksnap.io/img-original/a.jpg',
  thumbnail: 'https://api.openverse.org/v1/images/abc/thumb/',
  width: 4000,
  height: 2600,
  creator: 'Jane Doe',
  license: 'cc0',
  license_version: '1.0',
  provider: 'stocksnap',
  ...over
})

describe('find_stock_images', () => {
  let ctx: ToolContext
  let n = 0
  beforeEach(() => {
    ctx = { workspaceGuard: new WorkspaceGuard('/ws'), currentSessionId: `stock-${++n}` }
  })
  afterEach(() => vi.unstubAllGlobals())
  const stub = (body: unknown, status = 200) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('labels licences the way a credit line needs them', () => {
    expect(licenceLabel('by', '2.0')).toBe('CC BY 2.0')
    expect(licenceLabel('by-sa', '4.0')).toBe('CC BY-SA 4.0')
    expect(licenceLabel('cc0', '1.0')).toBe('CC0')
    expect(licenceLabel('pdm', undefined)).toBe('Public Domain')
  })

  it('searches for commercially usable, non-mature photographs in the slide-friendly wide shape, and lists direct URLs with a ready credit line', async () => {
    const fetchMock = stub({ results: [result(), result({ title: 'Servers', url: 'https://cdn.example.com/b.jpg', creator: 'Sam', license: 'by', license_version: '2.0', provider: 'flickr' })] })
    const out = String(await findStockImagesTool.execute({ query: 'team meeting office' }, ctx))
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]))
    expect(url.searchParams.get('q')).toBe('team meeting office')
    expect(url.searchParams.get('license_type')).toBe('commercial')
    expect(url.searchParams.get('mature')).toBe('false')
    expect(url.searchParams.get('aspect_ratio')).toBe('wide')
    expect(out).toContain('1. https://cdn.stocksnap.io/img-original/a.jpg')
    expect(out).toContain('Credit: Photo: Jane Doe (CC0)')
    expect(out).toContain('2. https://cdn.example.com/b.jpg')
    expect(out).toContain('Credit: Photo: Sam (CC BY 2.0)')
    expect(out).toMatch(/different photo on every slide/)
  })

  it('downloads Wikimedia through its small thumbnail (originals can be tens of megabytes), skips small images, and honours count', async () => {
    stub({ results: [result({ provider: 'wikimedia', url: 'https://upload.wikimedia.org/huge.jpg', thumbnail: 'https://api.openverse.org/v1/images/w/thumb/' }), result({ width: 300, url: 'https://cdn.example.com/tiny.jpg' }), result({ url: 'https://cdn.example.com/c.jpg' }), result({ url: 'https://cdn.example.com/d.jpg' })] })
    const out = String(await findStockImagesTool.execute({ query: 'x', count: 2 }, ctx))
    expect(out).toContain('1. https://api.openverse.org/v1/images/w/thumb/')
    expect(out).not.toContain('huge.jpg')
    expect(out).not.toContain('tiny.jpg')
    expect(out).toContain('2. https://cdn.example.com/c.jpg')
    expect(out).not.toContain('d.jpg')
  })

  it('makes every URL it lists a real one for this session, so download_image accepts it', async () => {
    stub({ results: [result()] })
    await findStockImagesTool.execute({ query: 'x' }, ctx)
    // The origin now has known URLs: the listed one passes, a made-up path on it does not.
    expect(checkUrlAllowed(ctx.currentSessionId, 'https://cdn.stocksnap.io/img-original/a.jpg')).toEqual({ allowed: true })
    expect(checkUrlAllowed(ctx.currentSessionId, 'https://cdn.stocksnap.io/img-original/invented.jpg')).toMatchObject({ allowed: false })
  })

  it('searches several pictures in one call (a whole deck at once), grouped by query, and caps it at 8', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [result()] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const out = String(await findStockImagesTool.execute({ queries: ['data center', 'team meeting', 'padlock'] }, ctx))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(out).toContain('for "data center"')
    expect(out).toContain('for "team meeting"')
    expect(out).toContain('for "padlock"')
    fetchMock.mockClear()
    await findStockImagesTool.execute({ queries: Array.from({ length: 12 }, (_, i) => `topic ${i}`) }, ctx)
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it('says plainly when nothing fits, and fails clearly on a service error', async () => {
    stub({ results: [] })
    expect(String(await findStockImagesTool.execute({ query: 'zzzz' }, ctx))).toMatch(/No stock photos found for "zzzz".*shorter, more concrete/)
    stub({}, 503)
    await expect(findStockImagesTool.execute({ query: 'x' }, ctx)).rejects.toThrow(/Stock image search failed: 503/)
    await expect(findStockImagesTool.execute({ query: '  ' }, ctx)).rejects.toThrow(/No query/)
  })
})
