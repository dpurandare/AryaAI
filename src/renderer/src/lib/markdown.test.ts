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
})
