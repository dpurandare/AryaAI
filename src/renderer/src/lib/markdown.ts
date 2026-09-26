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
  'hr',
  // TASKS.md #62 — a plain, inert container for a pending Mermaid diagram
  // placeholder (see extractMermaid below); no XSS surface of its own,
  // unlike widening this list for e.g. <script>/<iframe>/<object>.
  'div'
]

/**
 * Math delimiters the models emit — `\(...\)` inline, `\[...\]` and `$$...$$` block (confirmed live against real output, e.g. a physics
 * problem's worked solution).
 */
const MATH_PATTERNS: { regex: RegExp; displayMode: boolean }[] = [
  { regex: /\$\$([\s\S]+?)\$\$/g, displayMode: true },
  { regex: /\\\[([\s\S]+?)\\\]/g, displayMode: true },
  { regex: /\\\(([\s\S]+?)\\\)/g, displayMode: false }
]

/**
 * Bare single-`$...$` inline math — what several models (seen live: a Data Access answer full of `$613,898,527\text{ kWh}$`) use instead of
 * `\(...\)`. It used to be left out because of the classic false positive ("costs $5 to $10" is not math), so it is accepted only under
 * Pandoc's rules, which keep prices out: the opening `$` must be followed by a non-space, the closing `$` must be preceded by a non-space and
 * must NOT be followed by a digit, and neither may be a backslash-escaped `\$`. "$5 to $10" fails (a space before the second `$`), so does
 * "$5-$10" (a digit after it). One line only. Never applied inside code (see `extractMath`).
 */
const SINGLE_DOLLAR_MATH = /(?<![\\$])\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<=[^\s\\])\$(?![\d$])/g

/** Markdown code fences and inline code spans, kept out of the single-`$` pass — `awk '{print $1}' | sort $2` is shell, not math. */
const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/

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
  const renderToPlaceholder = (source: string, displayMode: boolean): string => {
    let html: string
    try {
      // A bare `%` is LaTeX's comment character — it swallows everything
      // to end-of-line, including the closing `}` of an enclosing
      // \text{...}. Found live: gpt-oss wrote `\text{ (130 %)}` for a
      // percentage, which KaTeX correctly rejected as "Unexpected end of
      // input in a macro argument, expected '}'", rendering as a visible
      // raw-LaTeX error instead of the number. Models reliably write a
      // literal `%` for "percent" without escaping it, so repair that one
      // specific, extremely common mistake before parsing rather than
      // showing every percentage as a parse error — an already-escaped
      // `\%` is left alone.
      const escaped = source.replace(/(?<!\\)%/g, '\\%')
      // trust: false (the default) keeps commands like \href/\includegraphics
      // inert — this text is untrusted model output, not authored LaTeX.
      html = katex.renderToString(escaped, { displayMode, throwOnError: false, trust: false, output: 'html' })
    } catch {
      // KaTeX's own parse errors are normally caught internally by
      // throwOnError:false and rendered as a visible red error span —
      // this is a last-resort net for anything that still throws, so a
      // single bad equation can't break the whole message.
      html = ''
    }
    const index = blocks.push(html) - 1
    return `${PH_START}${index}${PH_END}`
  }
  let result = text
  for (const { regex, displayMode } of MATH_PATTERNS) {
    result = result.replace(regex, (_match, source: string) => renderToPlaceholder(source, displayMode))
  }
  // Single-$ inline math, on the parts of the text that are not code (split() with a capture group puts the code segments at odd indices).
  result = result
    .split(CODE_SEGMENT)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(SINGLE_DOLLAR_MATH, (_m, source: string) => renderToPlaceholder(source, false))))
    .join('')
  return { text: result, blocks }
}

function restoreMath(html: string, blocks: string[]): string {
  return html.replace(PLACEHOLDER_RE, (_match, indexStr: string) => blocks[Number(indexStr)] ?? '')
}

/** The handful of entities `marked` actually produces inside a fenced code block's escaped text content — not a general HTML-entity decoder, just enough to recover the real Mermaid source it escaped. */
function decodeCodeFenceEntities(escaped: string): string {
  return escaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * TASKS.md #62 — pulled out of `marked`'s own HTML output (a ```mermaid
 * fence renders as an ordinary `<pre><code class="language-mermaid">...`
 * block, confirmed directly against `marked`'s real output, not assumed)
 * *before* sanitization, the same "extract, placeholder, splice back later"
 * shape `extractMath`/`restoreMath` already use above — but the actual
 * diagram rendering can't happen here: `mermaid.render()` is async, and
 * this function (like `renderMarkdown`) must stay synchronous so an
 * ordinary message with no diagram at all never pays an async round-trip
 * just to render plain text. The real SVG is filled in later, imperatively,
 * by `MarkdownText.svelte`'s own effect (see `mermaid-render.ts`) — this
 * only leaves a `data-mermaid-id`-tagged placeholder div for it to find.
 *
 * Extracted even for a still-streaming, *unclosed* fence — confirmed
 * against `marked`'s real behavior, not assumed: an unterminated GFM code
 * fence runs to end-of-input rather than being left unrecognized, so a
 * ```mermaid block mid-stream gets this same `<pre><code>` shape well
 * before its closing ``` has arrived. That's an accepted tradeoff, not a
 * bug: `mermaid-render.ts` ends up attempting a real render against a
 * still-growing, likely-invalid source on every token, which mostly just
 * fails fast into its own caught, harmless error state until the fence
 * closes and the source stabilizes — the *final* render, once streaming
 * genuinely stops, always sees the real, complete source.
 */
function extractMermaid(html: string): { html: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>()
  let counter = 0
  const result = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>\n?/g, (_match, escaped: string) => {
    const id = `mermaid-${counter++}`
    blocks.set(id, decodeCodeFenceEntities(escaped))
    return `<div class="mermaid-pending" data-mermaid-id="${id}">Rendering diagram…</div>`
  })
  return { html: result, blocks }
}

export interface RenderedMarkdown {
  html: string
  /** Raw Mermaid source per placeholder id, rendered asynchronously by the caller — see `extractMermaid`'s own doc comment for why this can't happen inside this (synchronous) function. Empty for the overwhelming majority of messages, which contain no diagram at all. */
  mermaidBlocks: Map<string, string>
}

export function renderMarkdown(text: string): RenderedMarkdown {
  const { text: withPlaceholders, blocks: mathBlocks } = extractMath(text)
  const dirty = marked.parse(withPlaceholders, { async: false }) as string
  const { html: dirtyWithMermaidPlaceholders, blocks: mermaidBlocks } = extractMermaid(dirty)
  const clean = DOMPurify.sanitize(dirtyWithMermaidPlaceholders, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'class', 'data-mermaid-id'],
    // Still blocks every OTHER data-* attribute broadly — data-mermaid-id
    // is allowed only because it's explicitly named in ALLOWED_ATTR above,
    // which DOMPurify always honors regardless of this flag.
    ALLOW_DATA_ATTR: false
  })
  return { html: restoreMath(clean, mathBlocks), mermaidBlocks }
}
