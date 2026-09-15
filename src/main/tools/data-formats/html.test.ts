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
})
