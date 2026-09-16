import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { Tool } from '../types'
import { checkUrlAllowed, recordKnownUrl } from './link-registry'
import { resolveSource } from './source'

const MAX_TEXT_CHARS = 10_000
const MAX_LINKS = 30
const MAX_LINK_TEXT_CHARS = 120

function stripBoilerplateText(html: string): string {
  const dom = new JSDOM(html)
  dom.window.document.querySelectorAll('script, style, noscript').forEach((el) => el.remove())
  return (dom.window.document.body?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n... (truncated, ${text.length - MAX_TEXT_CHARS} characters omitted)`
}

interface PageLink {
  text: string
  href: string
}

/**
 * Article text alone isn't enough for a listing/hub/topic page (a search
 * results page, a section front, a "latest on X" feed) — its whole value
 * *is* its links to individual articles, and Readability's own
 * textContent extraction discards every `<a href>` regardless. Found from
 * a real, repeated live failure: with no real links available, a model
 * pattern-matched a plausible-looking article URL from a headline it had
 * only seen as text and invented a slug/ID that doesn't exist — a 404,
 * twice, against two different news sites, for exactly this reason.
 * Absolute http(s) links only, deduped, capped, and only ones with real
 * anchor text (a bare icon/image link has nothing useful to show).
 */
function extractLinks(html: string, baseUrl: string): PageLink[] {
  const dom = new JSDOM(html, { url: baseUrl })
  const seen = new Set<string>()
  const links: PageLink[] = []
  for (const el of dom.window.document.querySelectorAll('a[href]')) {
    const raw = el.getAttribute('href')
    if (!raw) continue
    let href: string
    try {
      href = new URL(raw, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//.test(href) || seen.has(href)) continue
    const text = el.textContent?.trim().replace(/\s+/g, ' ') ?? ''
    if (!text) continue
    seen.add(href)
    links.push({ text: text.slice(0, MAX_LINK_TEXT_CHARS), href })
    if (links.length >= MAX_LINKS) break
  }
  return links
}

function formatLinks(links: PageLink[]): string {
  if (!links.length) return ''
  return `\n\nLinks on this page:\n${links.map((l) => `- ${l.text}: ${l.href}`).join('\n')}`
}

/** Files the fetched page itself, plus every real link extracted from it, as "known real" for this session — see link-registry.ts. Called regardless of source (url/filePath/text): a link discovered inside an inline/local HTML blob is just as real as one fetched live, and worth trusting for a later url fetch to that same origin. */
function recordDiscoveredLinks(sessionId: string, sourceUrl: string, links: PageLink[], isRealFetch: boolean): void {
  if (isRealFetch) recordKnownUrl(sessionId, sourceUrl)
  for (const link of links) recordKnownUrl(sessionId, link.href)
}

export const parseHtmlTool: Tool = {
  name: 'parse_html',
  description:
    'Extract the readable article text from an HTML page — reader-mode style, stripping navigation, ' +
    'ads, and script/style boilerplate — instead of you having to wade through raw HTML yourself. Also ' +
    'lists the real links found on the page (text + absolute URL, capped), which matters most for a ' +
    'listing/topic/search-results page — use one of THOSE real links for a follow-up parse_html call ' +
    'when you need a specific article. This is enforced, not just advised: once a real link has been ' +
    'seen for a site, a follow-up url that is not the site root and does not exactly match one of those ' +
    'real links is rejected outright, telling you to use a real one instead — constructing/guessing a ' +
    "path yourself will not work. Provide exactly one of url (fetches it directly — prefer this over " +
    'shell_execute/curl for reading a web page, since the raw HTML never has to pass through your own ' +
    'context), filePath (an HTML file already in the workspace), or text (inline HTML you already have). ' +
    "Falls back to a plain stripped-text dump when the page isn't recognizable as an article (e.g. an " +
    'app shell or listing page), and says so.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A URL to fetch and extract' },
      filePath: { type: 'string', description: 'Path to an HTML file, relative to the workspace root' },
      text: { type: 'string', description: 'Inline HTML to extract from' }
    }
  },
  mutates: false,
  async execute(input, ctx) {
    const isRealFetch = typeof input.url === 'string' && input.url !== ''
    if (isRealFetch) {
      const check = checkUrlAllowed(ctx.currentSessionId, input.url as string)
      if (!check.allowed) throw new Error(check.reason)
    }

    const { text: html } = await resolveSource(input, ctx)
    const sourceUrl = isRealFetch ? (input.url as string) : 'http://localhost/'

    const dom = new JSDOM(html, { url: sourceUrl })
    const article = new Readability(dom.window.document).parse()

    if (article) {
      const articleText = article.textContent?.trim()
      if (articleText) {
        const title = article.title ? `${article.title}\n\n` : ''
        const links = extractLinks(article.content ?? html, sourceUrl)
        recordDiscoveredLinks(ctx.currentSessionId, sourceUrl, links, isRealFetch)
        return title + truncate(articleText) + formatLinks(links)
      }
    }

    const fallback = stripBoilerplateText(html)
    if (!fallback) return '(no readable text found on this page)'
    const links = extractLinks(html, sourceUrl)
    recordDiscoveredLinks(ctx.currentSessionId, sourceUrl, links, isRealFetch)
    return (
      "(Readability couldn't identify article content on this page — showing raw extracted text " +
      'instead, which may include navigation/boilerplate.)\n\n' +
      truncate(fallback) +
      formatLinks(links)
    )
  }
}
