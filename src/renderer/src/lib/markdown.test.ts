// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders headers, bold, italics, lists, and code blocks', () => {
    const { html } = renderMarkdown(
      '# Title\n\n**bold** and *italic*\n\n- one\n- two\n\n```js\nconst x = 1\n```'
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<pre>')
  })

  it('preserves single newlines as line breaks', () => {
    const { html } = renderMarkdown('line one\nline two')
    expect(html).toContain('<br>')
  })

  it('strips img tags and inline event handlers', () => {
    const { html } = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<img')
  })

  it('strips javascript: URLs from links', () => {
    const { html } = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('adds target=_blank and rel=noopener to links', () => {
    const { html } = renderMarkdown('[a link](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not throw on unclosed/partial markdown (mid-stream simulation)', () => {
    expect(() => renderMarkdown('some **unclosed bold and ```unclosed code')).not.toThrow()
  })

  it('renders inline \\(...\\) math as real KaTeX markup, not literal backslashes', () => {
    const { html } = renderMarkdown('The area is \\(A = \\pi r^2\\), roughly.')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('\\(')
    expect(html).not.toContain('\\pi')
  })

  it('renders \\[...\\] and $$...$$ as display-mode KaTeX markup', () => {
    const { html: bracket } = renderMarkdown('\\[E = mc^2\\]')
    expect(bracket).toContain('katex-display')
    const { html: dollars } = renderMarkdown('$$E = mc^2$$')
    expect(dollars).toContain('katex-display')
  })

  it('renders math that sits inside a markdown table cell (the real shape a physics answer used live)', () => {
    const { html } = renderMarkdown(
      '| Step | Formula |\n|------|---------|\n| Time | \\(\\displaystyle t = \\sqrt{\\frac{2h}{g}}\\) |'
    )
    expect(html).toContain('<table>')
    expect(html).toContain('class="katex"')
  })

  it('leaves an unclosed/partial math delimiter unrendered as math instead of hanging (mid-stream simulation)', () => {
    // No closing \) yet — extractMath's regex requires a real match, so this
    // stays untouched and just flows through as ordinary markdown, where
    // CommonMark's own backslash-escaping rules (unrelated to math) turn
    // "\(" into a literal "(" — expected, not a math-handling regression.
    const { html } = renderMarkdown('Solving for \\(x = v_0')
    expect(html).toContain('Solving for (x = v_0')
    expect(html).not.toContain('class="katex"')
  })

  it('does not mistake plain currency amounts for math (no bare $...$ support)', () => {
    const { html } = renderMarkdown('It costs $5 to $10, depending on size.')
    expect(html).toContain('$5 to $10')
    expect(html).not.toContain('class="katex"')
  })

  it('degrades a genuinely malformed equation to a visible error instead of throwing or vanishing', () => {
    expect(() => renderMarkdown('Bad math: \\(\\frac{1\\)')).not.toThrow()
    const { html } = renderMarkdown('Bad math: \\(\\frac{1\\)')
    expect(html).toContain('katex-error')
  })

  it('escapes a bare % inside math instead of treating it as a LaTeX comment (real bug: gpt-oss wrote \\text{ (130 %)}, which ate the closing brace and rendered as a raw katex-error)', () => {
    const { html } = renderMarkdown('\\[\n\\text{PLF} = \\frac{613\\,898}{470\\,000} \\approx 1.30 \\text{ (130 %)}\n\\]')
    expect(html).toContain('class="katex-display"')
    expect(html).not.toContain('katex-error')
    expect(html).toContain('130')
  })

  it('leaves an already-escaped \\% alone (no double-escaping)', () => {
    const { html } = renderMarkdown('\\(50\\%\\)')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('katex-error')
  })

  describe('mermaid diagram extraction (TASKS.md #62)', () => {
    it('extracts a complete ```mermaid fence into a placeholder plus its real, decoded source', () => {
      const { html, mermaidBlocks } = renderMarkdown('```mermaid\ngraph TD;\n  A-->B;\n```')
      expect(html).toContain('class="mermaid-pending"')
      expect(html).toContain('data-mermaid-id="mermaid-0"')
      expect(html).not.toContain('<pre>')
      expect(mermaidBlocks.size).toBe(1)
      // The real, un-escaped source — marked HTML-escapes '>' inside a code
      // fence (A--&gt;B), which must be decoded back for mermaid.render().
      expect(mermaidBlocks.get('mermaid-0')).toBe('graph TD;\n  A-->B;\n')
    })

    it('still extracts an unclosed/partial ```mermaid fence (mid-stream simulation) — confirmed against marked\'s real behavior, not assumed: an unterminated GFM code fence runs to end-of-input rather than being left unrecognized', () => {
      // A real, accepted tradeoff, not a bug: mid-stream this hands
      // mermaid-render.ts a still-growing, likely-invalid source on every
      // token, which mostly just fails fast and shows a harmless, brief
      // error state (caught in mermaid-render.ts's own try/catch) until the
      // fence closes and the text stabilizes — the *final* render, once
      // streaming stops, always uses the real, complete source.
      const { html, mermaidBlocks } = renderMarkdown('```mermaid\ngraph TD;\n  A-->B')
      expect(mermaidBlocks.size).toBe(1)
      expect(html).toContain('mermaid-pending')
    })

    it('extracts multiple diagrams in the same message with distinct ids', () => {
      const { mermaidBlocks } = renderMarkdown(
        '```mermaid\ngraph TD;\n  A-->B;\n```\n\nSome text.\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```'
      )
      expect(mermaidBlocks.size).toBe(2)
      expect([...mermaidBlocks.values()]).toEqual([
        expect.stringContaining('graph TD'),
        expect.stringContaining('sequenceDiagram')
      ])
    })

    it('leaves an ordinary (non-mermaid) fenced code block rendering exactly as before', () => {
      const { html, mermaidBlocks } = renderMarkdown('```js\nconst x = 1\n```')
      expect(html).toContain('<pre>')
      expect(html).not.toContain('mermaid-pending')
      expect(mermaidBlocks.size).toBe(0)
    })

    it('the placeholder div and its data-mermaid-id attribute survive DOMPurify sanitization', () => {
      const { html } = renderMarkdown('```mermaid\ngraph TD;\n  A-->B;\n```')
      // A real assertion that DOMPurify's allowlist was actually widened
      // correctly, not just that the raw pre-sanitize string looked right.
      expect(html).toMatch(/<div class="mermaid-pending" data-mermaid-id="mermaid-0">/)
    })
  })
})
