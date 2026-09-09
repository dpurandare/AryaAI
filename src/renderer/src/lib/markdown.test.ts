// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders headers, bold, italics, lists, and code blocks', () => {
    const html = renderMarkdown(
      '# Title\n\n**bold** and *italic*\n\n- one\n- two\n\n```js\nconst x = 1\n```'
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<pre>')
  })

  it('preserves single newlines as line breaks', () => {
    const html = renderMarkdown('line one\nline two')
    expect(html).toContain('<br>')
  })

  it('strips img tags and inline event handlers', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<img')
  })

  it('strips javascript: URLs from links', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('adds target=_blank and rel=noopener to links', () => {
    const html = renderMarkdown('[a link](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not throw on unclosed/partial markdown (mid-stream simulation)', () => {
    expect(() => renderMarkdown('some **unclosed bold and ```unclosed code')).not.toThrow()
  })

  it('renders inline \\(...\\) math as real KaTeX markup, not literal backslashes', () => {
    const html = renderMarkdown('The area is \\(A = \\pi r^2\\), roughly.')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('\\(')
    expect(html).not.toContain('\\pi')
  })

  it('renders \\[...\\] and $$...$$ as display-mode KaTeX markup', () => {
    const bracket = renderMarkdown('\\[E = mc^2\\]')
    expect(bracket).toContain('katex-display')
    const dollars = renderMarkdown('$$E = mc^2$$')
    expect(dollars).toContain('katex-display')
  })

  it('renders math that sits inside a markdown table cell (the real shape a physics answer used live)', () => {
    const html = renderMarkdown(
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
    const html = renderMarkdown('Solving for \\(x = v_0')
    expect(html).toContain('Solving for (x = v_0')
    expect(html).not.toContain('class="katex"')
  })

  it('does not mistake plain currency amounts for math (no bare $...$ support)', () => {
    const html = renderMarkdown('It costs $5 to $10, depending on size.')
    expect(html).toContain('$5 to $10')
    expect(html).not.toContain('class="katex"')
  })

  it('degrades a genuinely malformed equation to a visible error instead of throwing or vanishing', () => {
    expect(() => renderMarkdown('Bad math: \\(\\frac{1\\)')).not.toThrow()
    const html = renderMarkdown('Bad math: \\(\\frac{1\\)')
    expect(html).toContain('katex-error')
  })
})
