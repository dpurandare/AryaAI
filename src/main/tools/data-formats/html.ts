import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { Tool } from '../types'
import { checkUrlAllowed, recordKnownUrl } from './link-registry'
import { resolveSource } from './source'

const MAX_TEXT_CHARS = 10_000
const MAX_LINKS = 30
const MAX_LINK_TEXT_CHARS = 120
const MAX_IMAGES = 20
const MAX_IMAGE_TEXT_CHARS = 80

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

interface PageImage {
  src: string
  alt: string
  /** Text of the nearest block around the image (a team card's name, a caption) — what ties a photo to a person or topic. */
  near: string
}

/**
 * The page's real `<img>` addresses. Found live: asked for a person's photo, the model had text and links from the
 * page but never an image URL, so it gave up and blamed login walls. Read from the FULL html, not Readability's
 * article body, which drops image-heavy sections such as a team grid. Absolute http(s) only (no data: URIs),
 * lazy-load attributes included, tiny tracking pixels and icons skipped, deduped, capped.
 */
function extractImages(html: string, baseUrl: string): PageImage[] {
  const dom = new JSDOM(html, { url: baseUrl })
  const seen = new Set<string>()
  const images: PageImage[] = []
  // The page's own declared main image (profile pages, articles and company pages set one for link previews) — often
  // the only real photo on a page whose <img> tags are filled in by JavaScript.
  for (const meta of dom.window.document.querySelectorAll('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], link[rel="image_src"]')) {
    const raw = meta.getAttribute('content') || meta.getAttribute('href')
    if (!raw) continue
    try {
      const src = new URL(raw, baseUrl).toString()
      if (/^https?:\/\//.test(src) && !seen.has(src)) {
        seen.add(src)
        images.push({ src, alt: '', near: "the page's own main image (og:image)" })
      }
    } catch {
      /* ignore a malformed address */
    }
  }
  for (const el of dom.window.document.querySelectorAll('img')) {
    const raw = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original')
    if (!raw || raw.startsWith('data:')) continue
    let src: string
    try {
      src = new URL(raw, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//.test(src) || seen.has(src)) continue
    const w = Number(el.getAttribute('width') ?? 0)
    const h = Number(el.getAttribute('height') ?? 0)
    if ((w > 0 && w <= 48) || (h > 0 && h <= 48) || /(^|[/_-])(pixel|spacer|blank|1x1|tracking|favicon)\b/i.test(src)) continue
    seen.add(src)
    let near = ''
    for (let node: Element | null = el.parentElement, depth = 0; node && depth < 4 && !near; node = node.parentElement, depth++) {
      // Tags become spaces, so a heading and the line under it do not run together ("NameFounder").
      const text = node.innerHTML
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      if (text.length >= 3 && text.length <= 240) near = text.slice(0, MAX_IMAGE_TEXT_CHARS)
    }
    images.push({ src, alt: (el.getAttribute('alt') ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_IMAGE_TEXT_CHARS), near })
    if (images.length >= MAX_IMAGES) break
  }
  return images
}

function formatImages(images: PageImage[]): string {
  if (!images.length) return ''
  const lines = images.map((i) => `- ${i.src}${i.alt ? ` (alt: ${i.alt})` : ''}${i.near ? ` [near: ${i.near}]` : ''}`)
  return `\n\nImages on this page (download_image saves one; an image is only the right one if its alt or nearby text says so):\n${lines.join('\n')}`
}

function formatLinks(links: PageLink[]): string {
  if (!links.length) return ''
  return `\n\nLinks on this page:\n${links.map((l) => `- ${l.text}: ${l.href}`).join('\n')}`
}

/** Files the fetched page itself, plus every real link extracted from it, as "known real" for this session — see link-registry.ts. Called regardless of source (url/filePath/text): a link discovered inside an inline/local HTML blob is just as real as one fetched live, and worth trusting for a later url fetch to that same origin. */
function recordDiscoveredLinks(sessionId: string, sourceUrl: string, links: PageLink[], isRealFetch: boolean, images: PageImage[] = []): void {
  if (isRealFetch) recordKnownUrl(sessionId, sourceUrl)
  for (const link of links) recordKnownUrl(sessionId, link.href)
  for (const image of images) recordKnownUrl(sessionId, image.src)
}

export const parseHtmlTool: Tool = {
  name: 'parse_html',
  description:
    'Extract the readable article text from an HTML page — reader-mode style, stripping navigation, ' +
    'ads, and script/style boilerplate — instead of you having to wade through raw HTML yourself. Also ' +
    'lists the real links found on the page (text + absolute URL, capped), which matters most for a ' +
    'listing/topic/search-results page — use one of THOSE real links for a follow-up parse_html call ' +
    'when you need a specific article. It also lists the page\'s images (URL, alt text, nearby text) for download_image. This is enforced, not just advised: once a real link has been ' +
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
        const images = extractImages(html, sourceUrl)
        recordDiscoveredLinks(ctx.currentSessionId, sourceUrl, links, isRealFetch, images)
        return title + truncate(articleText) + formatLinks(links) + formatImages(images)
      }
    }

    const fallback = stripBoilerplateText(html)
    if (!fallback) return '(no readable text found on this page)'
    const links = extractLinks(html, sourceUrl)
    const images = extractImages(html, sourceUrl)
    recordDiscoveredLinks(ctx.currentSessionId, sourceUrl, links, isRealFetch, images)
    return (
      "(Readability couldn't identify article content on this page — showing raw extracted text " +
      'instead, which may include navigation/boilerplate.)\n\n' +
      truncate(fallback) +
      formatLinks(links) +
      formatImages(images)
    )
  }
}
