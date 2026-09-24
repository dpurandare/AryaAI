import DOMPurify from 'dompurify'

/**
 * TASKS.md #62 — keyed by the exact diagram source text (not the
 * placeholder id, which is per-render and not stable across a streaming
 * message's repeated re-renders of the same logical diagram): a message
 * still streaming keeps regenerating its *entire* HTML on every token
 * (`{@html}` in MarkdownText.svelte fully replaces the container each
 * time), so the same already-rendered diagram would otherwise pay for a
 * real `mermaid.render()` parse+layout pass again on every unrelated
 * keystroke after it. A cache hit is synchronous — no flicker, no
 * re-render — even though the DOM node hosting it was just recreated.
 */
const renderCache = new Map<string, string>()

let mermaidModulePromise: Promise<typeof import('mermaid')> | undefined

/**
 * Dynamically imported, not a static top-level import — Mermaid is a
 * genuinely large dependency (its own grammar parser, multiple layout
 * engines, d3), and the overwhelming majority of conversations never
 * contain a diagram at all. Paying that bundle-size/parse cost only once a
 * ```mermaid block is actually encountered keeps the common case's
 * startup light. `securityLevel: 'strict'` (not the default 'loose') is
 * deliberate: diagram source ultimately comes from model output, which
 * this app treats as untrusted the same way it treats any other
 * model-produced content — strict mode is Mermaid's own hardened mode
 * (sanitizes label HTML internally, restricts click/interaction bindings).
 */
async function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidModulePromise ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
      // Forces plain SVG <text>/<tspan> labels instead of Mermaid's default
      // HTML-via-<foreignObject> label rendering — found live, not assumed:
      // foreignObject content lives in the XHTML namespace (an explicit
      // per-element `xmlns` on Mermaid's own generated markup), which
      // DOMPurify's `svg` profile does not reliably preserve even with
      // `ADD_TAGS`/`ADD_ATTR` for the nested div/span/p — confirmed by
      // direct inspection that sanitizing left an entirely empty
      // <foreignObject>, silently deleting every diagram label's text.
      // Plain SVG text needs no such namespace juggling and is already
      // handled correctly by DOMPurify's stock svg profile with zero
      // widening beyond it.
      htmlLabels: false
    })
    return m
  })
  return mermaidModulePromise
}

let renderIdCounter = 0

/**
 * Finds every not-yet-rendered `[data-mermaid-id]` placeholder inside
 * `container` (see `markdown.ts`'s `extractMermaid`) and replaces each with
 * its real, rendered SVG — in place, imperatively, once the async
 * render+sanitize completes. Safe to call repeatedly with an unchanged or
 * still-growing `blocks` map (e.g. once per streamed token): an id already
 * marked `data-mermaid-rendered` is skipped outright, and a cache hit for
 * an id that's new only because the DOM was recreated (not because the
 * diagram itself changed) resolves synchronously via `renderCache`.
 *
 * `container.contains(el)` is checked again after every `await` — the host
 * element can be a completely different DOM node by the time a real
 * `mermaid.render()` call resolves (the same streaming re-render race the
 * cache above exists for), and mutating a now-detached node would be a
 * silent no-op at best, a genuine bug at worst if it were ever reattached.
 */
export async function renderMermaidBlocks(container: HTMLElement, blocks: Map<string, string>): Promise<void> {
  for (const [id, source] of blocks) {
    const el = container.querySelector<HTMLElement>(`[data-mermaid-id="${id}"]`)
    if (!el || el.dataset.mermaidRendered === 'true') continue

    const cached = renderCache.get(source)
    if (cached !== undefined) {
      el.innerHTML = cached
      el.dataset.mermaidRendered = 'true'
      el.classList.remove('mermaid-pending')
      continue
    }

    const renderId = `mermaid-render-${renderIdCounter++}`
    try {
      const mermaid = (await loadMermaid()).default
      const { svg } = await mermaid.render(renderId, source)
      // SVG needs its own DOMPurify profile — the plain HTML allowlist
      // markdown.ts uses (ALLOWED_TAGS) has no <svg>/<path>/etc. entries at
      // all, and widening it generically just for this one case would miss
      // SVG's own distinct XSS surface (<foreignObject>, event-handler
      // attributes, etc.) that a plain HTML allowlist doesn't account for.
      // USE_PROFILES: { svg: true } is DOMPurify's own purpose-built
      // profile for exactly this, per TASKS.md #62's own stated need — the
      // stock profile alone, no widening: `htmlLabels: false` above means
      // Mermaid emits plain SVG <text>/<tspan> for every label, which this
      // profile already allows natively, rather than needing to also trust
      // HTML content nested inside a foreignObject.
      const cleanSvg = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
      renderCache.set(source, cleanSvg)
      if (container.contains(el)) {
        el.innerHTML = cleanSvg
        el.dataset.mermaidRendered = 'true'
        el.classList.remove('mermaid-pending')
      }
    } catch (err) {
      // A model can absolutely produce invalid diagram syntax — this must
      // degrade to a plain, honest error, never break the rest of the
      // message or leave the placeholder stuck on "Rendering diagram…"
      // forever.
      if (container.contains(el)) {
        el.textContent = `Could not render this diagram: ${err instanceof Error ? err.message : String(err)}`
        el.classList.add('mermaid-error')
        el.dataset.mermaidRendered = 'true'
      }
    } finally {
      // Found live, not assumed: mermaid.render() creates its own hidden
      // `#d<renderId>` sandbox element directly under <body> (outside our
      // container entirely) to do off-screen layout/measurement, and only
      // reliably cleans it up on success — on a genuine parse error it can
      // be left behind, complete with mermaid's own large built-in error
      // graphic rendered *into* it, a stray, visible artifact appearing
      // directly on the page unrelated to our own error handling above.
      document.getElementById(`d${renderId}`)?.remove()
    }
  }
}
