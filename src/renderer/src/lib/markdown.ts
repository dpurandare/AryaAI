import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'

marked.setOptions({ gfm: true, breaks: true })

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  's',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr'
]

/**
 * Math delimiters this model actually emits — `\(...\)` inline, `\[...\]`
 * and `$$...$$` block (confirmed live against real output, e.g. a physics
 * problem's worked solution). Deliberately no bare single-`$...$` support:
 * that's the classic false-positive source ("costs $5 to $10" isn't math),
 * and nothing observed from this app's providers actually emits it.
 */
const MATH_PATTERNS: { regex: RegExp; displayMode: boolean }[] = [
  { regex: /\$\$([\s\S]+?)\$\$/g, displayMode: true },
  { regex: /\\\[([\s\S]+?)\\\]/g, displayMode: true },
  { regex: /\\\(([\s\S]+?)\\\)/g, displayMode: false }
]

// Private-Use-Area characters bracketing the index — not valid in any real
// text a model would produce, so this can never collide with an ordinary
// number already in the prose (a plain "180" or "25" must survive
// untouched, not be mistaken for a placeholder).
const PH_START = ''
const PH_END = ''
const PLACEHOLDER_RE = new RegExp(`${PH_START}(\\d+)${PH_END}`, 'g')

/**
 * Pulled out of the raw markdown *before* `marked` ever sees it, not
 * rendered in place — LaTeX is full of characters (`_`, `*`, `\`, `{}`)
 * that markdown's own parser would otherwise mangle, and the source can
 * legitimately sit inside a table cell or list item (seen live), so this
 * has to work on the raw text regardless of surrounding structure. Each
 * match is replaced with a placeholder that's just plain text content —
 * left untouched by both `marked` and DOMPurify — then spliced back in as
 * the *last* step, after sanitization, using KaTeX's own trusted output
 * directly rather than asking DOMPurify's allowlist to accommodate it
 * (KaTeX's HTML output needs many `span`s with inline `style`, which this
 * app deliberately does NOT allow broadly — see the `<img>` reasoning
 * elsewhere in this file's history — this sidesteps that entirely rather
 * than widening the allowlist).
 */
function extractMath(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = []
  let result = text
  for (const { regex, displayMode } of MATH_PATTERNS) {
    result = result.replace(regex, (_match, source: string) => {
      let html: string
      try {
        // trust: false (the default) keeps commands like \href/\includegraphics
        // inert — this text is untrusted model output, not authored LaTeX.
        html = katex.renderToString(source, { displayMode, throwOnError: false, trust: false, output: 'html' })
      } catch {
        // KaTeX's own parse errors are normally caught internally by
        // throwOnError:false and rendered as a visible red error span —
        // this is a last-resort net for anything that still throws, so a
        // single bad equation can't break the whole message.
        html = ''
      }
      const index = blocks.push(html) - 1
      return `${PH_START}${index}${PH_END}`
    })
  }
  return { text: result, blocks }
}

function restoreMath(html: string, blocks: string[]): string {
  return html.replace(PLACEHOLDER_RE, (_match, indexStr: string) => blocks[Number(indexStr)] ?? '')
}

export function renderMarkdown(text: string): string {
  const { text: withPlaceholders, blocks } = extractMath(text)
  const dirty = marked.parse(withPlaceholders, { async: false }) as string
  const clean = DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'class'],
    ALLOW_DATA_ATTR: false
  })
  return restoreMath(clean, blocks)
}
