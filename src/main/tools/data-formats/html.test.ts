import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import { parseHtmlTool } from './html'
import type { ToolContext } from '../types'

// A real, Readability-recognizable article shape — enough distinct
// paragraphs of real text for Readability's own scoring heuristic to pick
// the <article> as the main content over the nav, matching what actually
// works in practice (a couple of one-line paragraphs don't score highly
// enough and Readability returns null instead, which is its own separate,
// also-tested fallback path below).
const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Ignored</title></head><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <article>
    <h1>A Real Article Title</h1>
    <p>${'This is the first real paragraph of the article, with enough substantive text in it. '.repeat(3)}</p>
    <p>${'This is a second paragraph continuing the same real article content for the reader. '.repeat(3)}</p>
    <p>${'And a third paragraph, still part of the same genuine article body copy. '.repeat(3)}</p>
  </article>
  <footer>Copyright 2026</footer>
</body></html>`

// Readability is lenient about *sparse* content (it'll happily return
// "Loading..." as a real, if useless, article rather than rejecting it —
// confirmed empirically, not assumed) — it only returns null outright for
// content with nothing to extract at all, which is the actual trigger for
// the fallback path below.
const EMPTY_HTML = `<html><body></body></html>`

let sessionCounter = 0

describe('parse_html', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-parse-html-'))
    // Unique per test — link-registry.ts's registry is session-scoped but
    // process-lifetime (not reset between tests), so a fixed shared id here
    // would let one test's recorded links leak into another's enforcement.
    sessionCounter++
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: `test-session-${sessionCounter}` }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is never mutating', () => {
    expect(parseHtmlTool.mutates).toBe(false)
  })

  it('extracts readable article text and title, stripping nav/footer boilerplate', async () => {
    const result = await parseHtmlTool.execute({ text: ARTICLE_HTML }, ctx)
    expect(result).toContain('A Real Article Title')
    expect(result).toContain('first real paragraph')
    expect(result).not.toContain('Copyright 2026')
    expect(result).not.toContain('About')
  })

  it('reports plainly when there is no readable text at all, rather than returning an empty string', async () => {
    const result = await parseHtmlTool.execute({ text: EMPTY_HTML }, ctx)
    expect(result).toBe('(no readable text found on this page)')
  })

  it('falls back to stripped plain text, with a note, when Readability returns null', async () => {
    const html = `<html><body><div id="app"><span>Loading, please wait...</span></div></body></html>`
    // Force the null path directly rather than hunting for real-world HTML
    // that happens to trip Readability's heuristics one way or the other —
    // the fallback's own formatting is what this test is actually checking.
    const { Readability } = await import('@mozilla/readability')
    const spy = vi.spyOn(Readability.prototype, 'parse').mockReturnValue(null)
    const result = await parseHtmlTool.execute({ text: html }, ctx)
    spy.mockRestore()

    expect(result).toMatch(/couldn't identify article content/)
    expect(result).toContain('Loading, please wait...')
  })

  it('fetches a URL directly rather than requiring the caller to already have the HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(ARTICLE_HTML, { status: 200 })))
    const result = await parseHtmlTool.execute({ url: 'https://example.com/article' }, ctx)
    expect(result).toContain('A Real Article Title')
    vi.unstubAllGlobals()
  })

  it('truncates a very long article with a clear marker', async () => {
    const longParagraph = `<p>${'word '.repeat(20_000)}</p>`
    const longHtml = `<html><body><article><h1>Long</h1>${longParagraph}</article></body></html>`
    const result = await parseHtmlTool.execute({ text: longHtml }, ctx)
    expect(result).toContain('(truncated,')
  })

  describe('link extraction', () => {
    // Readability's article-selection heuristic is already covered by the
    // tests above — mocking its return value here isolates extractLinks'
    // own logic (resolution/filtering/dedup) from that separate, fuzzier
    // question of which HTML shape it decides is "the article".
    async function withMockedArticle(content: string, run: () => Promise<string>): Promise<string> {
      const { Readability } = await import('@mozilla/readability')
      const spy = vi.spyOn(Readability.prototype, 'parse').mockReturnValue({
        title: 'Topic Page',
        textContent: 'A listing of real headlines.',
        content,
        byline: null,
        dir: null,
        lang: null,
        excerpt: '',
        length: 10,
        siteName: null,
        publishedTime: null
      })
      try {
        return await run()
      } finally {
        spy.mockRestore()
      }
    }

    it('lists real links found within the article content — the actual motivation: a listing/topic page is mostly links, and Readability strips them from plain text', async () => {
      const content =
        '<div>' +
        '<a href="/city/mumbai/some-real-article/articleshow/12345.cms">Real headline one</a>' +
        '<a href="https://example.com/other-real-article">Real headline two</a>' +
        '</div>'
      const result = await withMockedArticle(content, () => parseHtmlTool.execute({ text: '<html></html>' }, ctx))

      expect(result).toContain('Links on this page:')
      expect(result).toContain('- Real headline one: http://localhost/city/mumbai/some-real-article/articleshow/12345.cms')
      expect(result).toContain('- Real headline two: https://example.com/other-real-article')
    })

    it('resolves a relative href against the real source URL, not a placeholder', async () => {
      const content = '<a href="/articleshow/12345.cms">Headline</a>'
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>', { status: 200 })))
      const result = await withMockedArticle(content, () =>
        parseHtmlTool.execute({ url: 'https://timesofindia.indiatimes.com/topic/x' }, ctx)
      )
      vi.unstubAllGlobals()

      expect(result).toContain('https://timesofindia.indiatimes.com/articleshow/12345.cms')
    })

    it('excludes a link with no anchor text — nothing useful to offer for it', async () => {
      const content = '<a href="/no-text.cms"></a><a href="/real.cms">Real headline</a>'
      const result = await withMockedArticle(content, () => parseHtmlTool.execute({ text: '<html></html>' }, ctx))

      expect(result).not.toContain('no-text.cms')
      expect(result).toContain('real.cms')
    })

    it('excludes a non-http(s) link (e.g. mailto:, javascript:)', async () => {
      const content = '<a href="mailto:x@example.com">Email us</a><a href="javascript:void(0)">Click</a>'
      const result = await withMockedArticle(content, () => parseHtmlTool.execute({ text: '<html></html>' }, ctx))

      expect(result).not.toContain('Links on this page:')
    })

    it('dedupes a link that appears more than once', async () => {
      const content = '<a href="/x.cms">First mention</a><a href="/x.cms">Second mention, same link</a>'
      const result = await withMockedArticle(content, () => parseHtmlTool.execute({ text: '<html></html>' }, ctx))

      expect(result.match(/x\.cms/g)).toHaveLength(1)
    })

    it('caps the number of links listed', async () => {
      const content = Array.from({ length: 50 }, (_, i) => `<a href="/article-${i}.cms">Headline ${i}</a>`).join('')
      const result = await withMockedArticle(content, () => parseHtmlTool.execute({ text: '<html></html>' }, ctx))

      const linkLines = result.split('\n').filter((line) => line.startsWith('- '))
      expect(linkLines.length).toBeLessThanOrEqual(30)
    })

    it('extracts links on the Readability-null fallback path too', async () => {
      const { Readability } = await import('@mozilla/readability')
      const spy = vi.spyOn(Readability.prototype, 'parse').mockReturnValue(null)
      const html = '<html><body><span>Loading...</span><a href="/real.cms">A real link</a></body></html>'
      const result = await parseHtmlTool.execute({ text: html }, ctx)
      spy.mockRestore()

      expect(result).toContain('Links on this page:')
      expect(result).toContain('real.cms')
    })

    it('omits the links section entirely when there are none', async () => {
      const result = await withMockedArticle('<div>no links here</div>', () =>
        parseHtmlTool.execute({ text: '<html></html>' }, ctx)
      )
      expect(result).not.toContain('Links on this page:')
    })
  })

  describe('real-link reuse enforcement (link-registry.ts)', () => {
    // A real, Readability-recognizable article containing one real link —
    // reused across these tests as "the page that establishes real links
    // for an origin" before testing what happens on the follow-up fetch.
    const LISTING_HTML = `<!DOCTYPE html><html><body><article>
      <h1>A Real Listing Page</h1>
      <p>${'Enough real body text for Readability to treat this as the article. '.repeat(4)}</p>
      <a href="/real-article-123.cms">A real headline</a>
    </article></body></html>`

    it('allows the very first fetch to a brand-new origin, path and all — cold start can\'t be told apart from a user-given URL', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(LISTING_HTML, { status: 200 })))
      const result = await parseHtmlTool.execute({ url: 'https://news.example.com/some/path' }, ctx)
      vi.unstubAllGlobals()
      expect(result).toContain('A Real Listing Page')
    })

    it('rejects a fabricated follow-up path once a real link is on file for that origin', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(LISTING_HTML, { status: 200 })))
      await parseHtmlTool.execute({ url: 'https://news.example.com/topic/x' }, ctx)
      vi.unstubAllGlobals()

      await expect(
        parseHtmlTool.execute({ url: 'https://news.example.com/a-completely-invented-article-999.cms' }, ctx)
      ).rejects.toThrow(/never guess or construct a path/)
    })

    it('allows a follow-up fetch that uses one of the real extracted links', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response(LISTING_HTML, { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      await parseHtmlTool.execute({ url: 'https://news.example.com/topic/x' }, ctx)

      // The extracted link resolves relative to the topic page's own URL —
      // confirm we're using exactly that resolved form, not a guess.
      const result = await parseHtmlTool.execute({ url: 'https://news.example.com/real-article-123.cms' }, ctx)
      vi.unstubAllGlobals()
      expect(result).toContain('A Real Listing Page')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('always allows re-fetching the bare origin root, even after real links are known', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(LISTING_HTML, { status: 200 })))
      await parseHtmlTool.execute({ url: 'https://news.example.com/topic/x' }, ctx)
      const result = await parseHtmlTool.execute({ url: 'https://news.example.com/' }, ctx)
      vi.unstubAllGlobals()
      expect(result).toContain('A Real Listing Page')
    })

    it('does not let a rejected guess reach the real fetch at all', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(LISTING_HTML, { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      await parseHtmlTool.execute({ url: 'https://news.example.com/topic/x' }, ctx)
      fetchMock.mockClear()

      await expect(parseHtmlTool.execute({ url: 'https://news.example.com/invented.cms' }, ctx)).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('scopes enforcement per session — a different conversation is not restricted by this one\'s known links', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(LISTING_HTML, { status: 200 })))
      await parseHtmlTool.execute({ url: 'https://news.example.com/topic/x' }, ctx)

      const otherCtx: ToolContext = { workspaceGuard: ctx.workspaceGuard, currentSessionId: 'a-completely-different-session' }
      // Cold start in the other session — allowed, not rejected by ctx's history.
      const result = await parseHtmlTool.execute({ url: 'https://news.example.com/some/other/guessed/path' }, otherCtx)
      vi.unstubAllGlobals()
      expect(result).toContain('A Real Listing Page')
    })
  })

  describe('page images', () => {
    const TEAM_HTML = `<html><body>
      <div class="team"><div class="card"><img src="/wp-content/team-4.png" alt=""><div class="bio"><h2>Vinod Himatsinghani</h2><h5>Founder</h5></div></div>
      <div class="card"><img data-src="https://cdn.example.com/a.jpg" alt="Deepak Chandwani"><h2>Deepak Chandwani</h2></div></div>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="inline">
      <img src="/pixel.gif" width="1" height="1">
      <img src="/wp-content/team-4.png" alt="duplicate">
    </body></html>`

    it('lists a page\'s real images with alt and nearby text, skipping data URIs, tiny pixels and duplicates — even from sections Readability drops', async () => {
      const out = String(await parseHtmlTool.execute({ text: TEAM_HTML }, ctx))
      expect(out).toContain('Images on this page')
      expect(out).toContain('http://localhost/wp-content/team-4.png [near: Vinod Himatsinghani Founder]')
      expect(out).toContain('https://cdn.example.com/a.jpg (alt: Deepak Chandwani)')
      expect(out).not.toContain('data:image')
      expect(out).not.toContain('pixel.gif')
      expect(out.match(/team-4\.png/g)).toHaveLength(1)
    })

    it("lists the page's own declared main image (og:image) first — often the only real photo on a page whose img tags are filled in by script", async () => {
      const html = '<html><head><meta property="og:image" content="https://cdn.example.com/og/profile.jpg"></head><body><h1>Someone</h1><div id="app"></div></body></html>'
      const out = String(await parseHtmlTool.execute({ text: html }, ctx))
      expect(out).toContain("- https://cdn.example.com/og/profile.jpg [near: the page's own main image (og:image)]")
    })

    it('says nothing about images when a page has none', async () => {
      const out = String(await parseHtmlTool.execute({ text: ARTICLE_HTML }, ctx))
      expect(out).not.toContain('Images on this page')
    })
  })
})
