// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// mermaid's real render() needs a genuine browser SVG layout engine
// (getBBox etc.) that jsdom doesn't implement — confirmed live, not
// assumed: a direct smoke test against the real package throws
// "getBBox is not a function" under jsdom. Mocked here so this file's own
// logic (caching, DOM updates, stale-element guarding, error handling) is
// still exercised; the real rendered-SVG-actually-appears behavior is
// live-verified separately (TASKS.md #62), same as #82/#87/#88.
const mockRender = vi.fn()
const mockInitialize = vi.fn()
vi.mock('mermaid', () => ({
  default: { render: mockRender, initialize: mockInitialize }
}))

// Imported after the mock so the module picks up the mocked mermaid.
const { renderMermaidBlocks } = await import('./mermaid-render')

describe('renderMermaidBlocks', () => {
  beforeEach(() => {
    mockRender.mockReset()
    mockInitialize.mockReset()
  })

  function containerWithPlaceholder(id: string): HTMLElement {
    const container = document.createElement('div')
    const placeholder = document.createElement('div')
    placeholder.className = 'mermaid-pending'
    placeholder.dataset.mermaidId = id
    placeholder.textContent = 'Rendering diagram…'
    container.appendChild(placeholder)
    return container
  }

  it('renders a diagram and replaces the placeholder with sanitized SVG, marking it done', async () => {
    mockRender.mockResolvedValue({ svg: '<svg><rect width="1" height="1"/></svg>' })
    const container = containerWithPlaceholder('mermaid-0')

    await renderMermaidBlocks(container, new Map([['mermaid-0', 'graph TD;\n  A-->B;']]))

    const el = container.querySelector('[data-mermaid-id="mermaid-0"]') as HTMLElement
    expect(el.innerHTML).toContain('<svg')
    expect(el.dataset.mermaidRendered).toBe('true')
    expect(el.classList.contains('mermaid-pending')).toBe(false)
    expect(mockRender).toHaveBeenCalledTimes(1)
    expect(mockRender.mock.calls[0][1]).toBe('graph TD;\n  A-->B;')
  })

  it('sanitizes the SVG through DOMPurify — a real script-bearing payload is stripped, not passed through raw', async () => {
    // A distinct source from every other test in this file — the render
    // cache is a real module-level singleton shared across all of them, so
    // reusing a source another test already rendered would silently hit
    // that cache and never exercise this test's own malicious payload.
    mockRender.mockResolvedValue({ svg: '<svg><script>alert(1)</script><rect width="1" height="1"/></svg>' })
    const container = containerWithPlaceholder('mermaid-0')

    await renderMermaidBlocks(container, new Map([['mermaid-0', 'graph TD;\n  A-->SCRIPTTEST;']]))

    const el = container.querySelector('[data-mermaid-id="mermaid-0"]') as HTMLElement
    expect(el.innerHTML).not.toContain('<script')
    expect(el.innerHTML).not.toContain('alert(1)')
  })

  it('caches by diagram source text — a second call with the identical source never calls mermaid.render() again', async () => {
    mockRender.mockResolvedValue({ svg: '<svg><rect width="1" height="1"/></svg>' })
    const source = 'graph TD;\n  A-->CACHETEST;'

    const first = containerWithPlaceholder('mermaid-0')
    await renderMermaidBlocks(first, new Map([['mermaid-0', source]]))
    expect(mockRender).toHaveBeenCalledTimes(1)

    // A fresh container/id — simulating the placeholder DOM node being
    // recreated by a streaming re-render, exactly as mermaid-render.ts's
    // own doc comment describes — but the *source text* is unchanged.
    const second = containerWithPlaceholder('mermaid-7')
    await renderMermaidBlocks(second, new Map([['mermaid-7', source]]))

    expect(mockRender).toHaveBeenCalledTimes(1) // still just once — the cache hit
    const el = second.querySelector('[data-mermaid-id="mermaid-7"]') as HTMLElement
    expect(el.innerHTML).toContain('<svg')
    expect(el.dataset.mermaidRendered).toBe('true')
  })

  it('skips an id already marked rendered, even if called again', async () => {
    mockRender.mockResolvedValue({ svg: '<svg></svg>' })
    const container = containerWithPlaceholder('mermaid-0')
    await renderMermaidBlocks(container, new Map([['mermaid-0', 'graph TD;\n  A-->SKIPTEST;']]))
    expect(mockRender).toHaveBeenCalledTimes(1)

    await renderMermaidBlocks(container, new Map([['mermaid-0', 'graph TD;\n  A-->SKIPTEST;']]))
    expect(mockRender).toHaveBeenCalledTimes(1) // not called a second time for the same already-rendered id
  })

  it('shows a plain, honest error instead of throwing or leaving the placeholder stuck, when the diagram source is invalid', async () => {
    mockRender.mockRejectedValue(new Error('Parse error on line 1'))
    const container = containerWithPlaceholder('mermaid-0')

    await expect(renderMermaidBlocks(container, new Map([['mermaid-0', 'not a real diagram']]))).resolves.toBeUndefined()

    const el = container.querySelector('[data-mermaid-id="mermaid-0"]') as HTMLElement
    expect(el.textContent).toMatch(/could not render this diagram/i)
    expect(el.textContent).toContain('Parse error on line 1')
    expect(el.classList.contains('mermaid-error')).toBe(true)
    expect(el.dataset.mermaidRendered).toBe('true') // doesn't retry forever on a permanently-invalid diagram
  })

  it('does nothing for a missing placeholder (already gone from the DOM) rather than throwing', async () => {
    const container = document.createElement('div') // no placeholder at all
    await expect(renderMermaidBlocks(container, new Map([['mermaid-0', 'graph TD;\n  A-->B;']]))).resolves.toBeUndefined()
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('does not mutate a placeholder that was detached from the container while the async render was in flight', async () => {
    let resolveRender!: (value: { svg: string }) => void
    mockRender.mockReturnValue(new Promise((resolve) => (resolveRender = resolve)))
    const container = containerWithPlaceholder('mermaid-0')
    const el = container.querySelector('[data-mermaid-id="mermaid-0"]') as HTMLElement

    const pending = renderMermaidBlocks(container, new Map([['mermaid-0', 'graph TD;\n  A-->C;']]))
    // Simulate a streaming re-render replacing the whole container's
    // content before this render resolves.
    container.removeChild(el)

    resolveRender({ svg: '<svg></svg>' })
    await pending

    expect(el.innerHTML).toBe('Rendering diagram…') // untouched — never wrote into a detached node
  })
})
