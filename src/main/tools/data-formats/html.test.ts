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

describe('parse_html', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-parse-html-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
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
})
