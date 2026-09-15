import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { Tool } from '../types'
import { resolveSource } from './source'

const MAX_TEXT_CHARS = 10_000

function stripBoilerplateText(html: string): string {
  const dom = new JSDOM(html)
  dom.window.document.querySelectorAll('script, style, noscript').forEach((el) => el.remove())
  return (dom.window.document.body?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n... (truncated, ${text.length - MAX_TEXT_CHARS} characters omitted)`
}

export const parseHtmlTool: Tool = {
  name: 'parse_html',
  description:
    'Extract the readable article text from an HTML page — reader-mode style, stripping navigation, ' +
    'ads, and script/style boilerplate — instead of you having to wade through raw HTML yourself. ' +
    'Provide exactly one of url (fetches it directly — prefer this over shell_execute/curl for reading ' +
    "a web page, since the raw HTML never has to pass through your own context), filePath (an HTML file " +
    "already in the workspace), or text (inline HTML you already have). Falls back to a plain stripped-" +
    "text dump when the page isn't recognizable as an article (e.g. a app shell or listing page), and " +
    'says so.',
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
    const { text: html } = await resolveSource(input, ctx)
    const sourceUrl = typeof input.url === 'string' ? input.url : 'http://localhost/'

    const dom = new JSDOM(html, { url: sourceUrl })
    const article = new Readability(dom.window.document).parse()

    if (article) {
      const articleText = article.textContent?.trim()
      if (articleText) {
        const title = article.title ? `${article.title}\n\n` : ''
        return title + truncate(articleText)
      }
    }

    const fallback = stripBoilerplateText(html)
    if (!fallback) return '(no readable text found on this page)'
    return (
      "(Readability couldn't identify article content on this page — showing raw extracted text " +
      'instead, which may include navigation/boilerplate.)\n\n' +
      truncate(fallback)
    )
  }
}
