<script lang="ts">
  import { renderMarkdown } from '../markdown'
  import { renderMermaidBlocks } from '../mermaid-render'

  let { text }: { text: string } = $props()
  const rendered = $derived(renderMarkdown(text))
  let containerEl: HTMLDivElement | undefined = $state()

  // TASKS.md #62 — reruns on every change to `rendered` (including each
  // token of a still-streaming message), but `renderMermaidBlocks` itself
  // is cheap to call redundantly: an already-rendered id is skipped, and a
  // diagram whose source hasn't actually changed resolves from its cache
  // synchronously — see mermaid-render.ts's own doc comment for why a
  // streaming message's placeholder DOM nodes aren't stable across calls.
  $effect(() => {
    if (containerEl) void renderMermaidBlocks(containerEl, rendered.mermaidBlocks)
  })
</script>

<div class="markdown-body" bind:this={containerEl}>{@html rendered.html}</div>

<style>
  /* `{@html}` content never gets Svelte's scoping hash, so every descendant
     selector here must stay :global — only the outer .markdown-body div
     itself (a real templated element) can be scoped. */
  .markdown-body :global(p) {
    margin: 0 0 0.5em;
  }
  .markdown-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin: 0.8em 0 0.4em;
    font-weight: 600;
    line-height: 1.3;
  }
  .markdown-body :global(h1:first-child),
  .markdown-body :global(h2:first-child),
  .markdown-body :global(h3:first-child) {
    margin-top: 0;
  }
  .markdown-body :global(h1) {
    font-size: 1.4rem;
  }
  .markdown-body :global(h2) {
    font-size: 1.25rem;
  }
  .markdown-body :global(h3) {
    font-size: 1.1rem;
  }
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    font-size: 1rem;
  }
  .markdown-body :global(strong) {
    font-weight: 700;
  }
  .markdown-body :global(em) {
    font-style: italic;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0.4em 0;
    padding-left: 1.4em;
  }
  .markdown-body :global(li) {
    margin: 0.15em 0;
  }
  .markdown-body :global(blockquote) {
    margin: 0.5em 0;
    padding-left: 0.75em;
    border-left: 3px solid var(--border);
    color: var(--text-muted);
  }
  .markdown-body :global(code) {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.85em;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.1em 0.35em;
  }
  .markdown-body :global(pre) {
    margin: 0.5em 0;
    padding: 0.6em 0.75em;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow-x: auto;
    max-width: 100%;
  }
  .markdown-body :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.8rem;
    white-space: pre;
  }
  .markdown-body :global(a) {
    color: var(--accent);
    text-decoration: underline;
  }
  /* KaTeX lays out a formula with `white-space: nowrap` internally (it has
     to — glyph positions are relative, not reflowable) and ships no
     container of its own to cap it — same overflow problem `pre`/`table`
     above already solve, just missing for math. Hit live: a single inline
     `$...$` spanning a long comma list of numbers pushed the whole chat
     panel wider instead of scrolling in place. `inline-block` is needed
     for standalone inline math since plain `overflow-x` is a no-op on an
     inline box; the display-mode override after it re-asserts KaTeX's own
     `.katex-display > .katex { display: block }` at matching specificity
     so block/centered equations aren't affected. */
  .markdown-body :global(.katex) {
    display: inline-block;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .markdown-body :global(.katex-display) {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .markdown-body :global(.katex-display > .katex) {
    display: block;
  }
  .markdown-body :global(table) {
    border-collapse: collapse;
    margin: 0.5em 0;
    max-width: 100%;
    display: block;
    overflow-x: auto;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--border);
    padding: 0.3em 0.6em;
  }
  /* TASKS.md #62 — the placeholder shown while mermaid-render.ts's async
     render is still in flight (typically brief, but real for a large
     diagram). */
  .markdown-body :global(.mermaid-pending) {
    margin: 0.5em 0;
    padding: 0.6em 0.75em;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.85rem;
  }
  .markdown-body :global(.mermaid-error) {
    font-style: normal;
    color: var(--warn);
  }
  /* Once rendered, the placeholder's innerHTML is the diagram's own <svg> —
     these rules target that replacement content, not a separate element. */
  .markdown-body :global(.mermaid-pending[data-mermaid-rendered='true']:not(.mermaid-error)) {
    padding: 0.5em;
    text-align: center;
  }
  .markdown-body :global(.mermaid-pending[data-mermaid-rendered='true']:not(.mermaid-error) svg) {
    max-width: 100%;
    height: auto;
  }
</style>
