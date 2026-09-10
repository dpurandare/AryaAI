<script lang="ts">
  import { renderMarkdown } from '../markdown'

  let { text }: { text: string } = $props()
  const html = $derived(renderMarkdown(text))
</script>

<div class="markdown-body">{@html html}</div>

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
</style>
