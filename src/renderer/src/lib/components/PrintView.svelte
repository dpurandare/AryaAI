<script lang="ts">
  import { onMount, tick } from 'svelte'
  import MarkdownText from './MarkdownText.svelte'
  import { roleLabel } from '@shared/agents'
  import type { MessageDto, RoleRosterEntryDto } from '@shared/ipc-contract'

  let title = $state('Chat export')
  let messages = $state<MessageDto[]>([])
  let error = $state('')
  let roster = $state<RoleRosterEntryDto[]>([])
  /** The roster's label (covers user-defined roles), else the built-in / humanized one. */
  const label = (id: string): string => roster.find((r) => r.id === id)?.label ?? roleLabel(id)

  /** A pure-tool_result message is the continuation of the tool call just shown, not a new turn — same convention as export.ts's Markdown export. */
  function isPureToolResult(message: MessageDto): boolean {
    return message.content.length > 0 && message.content.every((b) => b.type === 'tool_result')
  }

  onMount(async () => {
    try {
      const sessionId = new URLSearchParams(location.search).get('sessionId')
      if (!sessionId) throw new Error('Missing sessionId in print URL')
      window.sachiv.getRoles().then((r) => (roster = r.roles)).catch(() => {})
      const [sessions, records] = await Promise.all([
        window.sachiv.listSessions(),
        window.sachiv.listMessages(sessionId)
      ])
      title = sessions.find((s) => s.id === sessionId)?.title ?? title
      messages = records
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      // Wait for the DOM to actually reflect the state above, and for
      // KaTeX's @font-face glyphs to finish loading — otherwise printToPDF
      // can fire mid-layout or with fallback tofu glyphs in math.
      await tick()
      await document.fonts.ready
      window.sachiv.notifyPrintReady()
    }
  })
</script>

<div class="print-page">
  <h1>{title}</h1>
  {#if error}
    <p class="error">Could not build this export: {error}</p>
  {/if}
  {#each messages as message (message.id)}
    {#if !isPureToolResult(message)}
      <h2>{message.role === 'user' ? 'User' : 'Assistant'}</h2>
    {/if}
    {#each message.content as block, i (i)}
      {#if block.type === 'text'}
        {#if block.agentRole}
          <div class="agent-chip">{label(block.agentRole)} agent</div>
        {/if}
        <MarkdownText text={block.text} />
      {:else if block.type === 'tool_use'}
        <div class="tool-call">
          <div class="tool-call-head">
            <span class="tool-icon">⚙</span>
            <code>{block.name}</code>
            <span class="tool-input">{JSON.stringify(block.input)}</span>
          </div>
        </div>
      {:else if block.type === 'tool_result'}
        <div class="tool-result" class:error={block.isError}>{block.content}</div>
      {/if}
    {/each}
  {/each}
</div>

<style>
  .print-page {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
    font-size: 0.92rem;
    line-height: 1.5;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0 0 1.25rem;
  }
  h2 {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: 1.4rem 0 0.4rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }
  h2:first-of-type {
    border-top: none;
    padding-top: 0;
  }
  .error {
    color: var(--danger);
  }
  .agent-chip {
    display: inline-block;
    margin-bottom: 0.3rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--accent);
    font-size: 0.7rem;
    font-weight: 600;
  }
  .tool-call {
    margin: 0.5rem 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    background: var(--panel);
    /* Chrome's print path drops backgrounds unless the page opts in via
       printToPDF's printBackground option (set in export.ts) — this
       declaration alone does nothing without that. */
  }
  .tool-call-head {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.8rem;
  }
  .tool-icon {
    color: var(--accent);
  }
  .tool-input {
    color: var(--text-muted);
    word-break: break-all;
  }
  .tool-result {
    margin-top: 0.35rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool-result.error {
    color: var(--warn);
  }
</style>
