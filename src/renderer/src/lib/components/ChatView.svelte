<script lang="ts">
  import { tick } from 'svelte'
  import ModelPicker from './ModelPicker.svelte'
  import ContextMeter from './ContextMeter.svelte'
  import MarkdownText from './MarkdownText.svelte'
  import { AGENT_ROLES, AGENT_ROLE_LABELS, type AgentRole } from '@shared/agents'

  interface ToolCallDisplay {
    id: string
    name: string
    input: string
    result?: string
    isError?: boolean
  }

  interface DisplaySegment {
    id: string
    kind: 'text' | 'tool'
    agentRole?: AgentRole
    text?: string
    toolCall?: ToolCallDisplay
  }

  interface DisplayMessage {
    id: string
    role: 'user' | 'assistant'
    pending?: boolean
    statusText?: string
    segments: DisplaySegment[]
  }

  interface Provider {
    id: string
    displayName: string
  }

  let {
    messages = [],
    statusLine = '',
    sending = false,
    onSend,
    onStop,
    providers,
    providerId,
    model,
    hasKey,
    onChangeProvider,
    onChangeModel,
    onNeedKey,
    sessionUsage
  }: {
    messages: DisplayMessage[]
    statusLine: string
    sending: boolean
    onSend: (text: string, forcedRole?: AgentRole | null) => void
    onStop: () => void
    providers: readonly Provider[]
    providerId: string
    model: string
    hasKey: boolean
    onChangeProvider: (id: string) => void
    onChangeModel: (model: string) => void
    onNeedKey: () => void
    sessionUsage: { inputTokens: number; outputTokens: number }
  } = $props()

  let draft = $state('')
  // Plain $state object, not $state(new Set()) — a raw Set's own add/delete
  // methods aren't deep-reactive under Svelte 5 runes (that needs SvelteSet
  // from svelte/reactivity); property writes on a plain object are, and
  // that's already the pattern used elsewhere in this app (verified live:
  // a Set here silently never triggered a re-render on click).
  let expandedIds = $state<Record<string, boolean>>({})

  const PREVIEW_MAX_CHARS = 500
  const PREVIEW_MAX_LINES = 10

  // The `.messages` div never scrolled itself — new content (a sent
  // message, a streamed reply) just extended past the bottom of the
  // scrollport with no code anywhere driving scrollTop, so anything past
  // the first screenful required a manual scroll to see. `stickToBottom`
  // is true by default (and whenever the user is already near the
  // bottom or just sent something) so streaming naturally follows the
  // newest content; it goes false only once the user deliberately
  // scrolls up to read earlier history, so we don't yank them back down
  // mid-read.
  let messagesEl: HTMLDivElement | undefined = $state()
  let stickToBottom = $state(true)
  const BOTTOM_THRESHOLD_PX = 48

  function onMessagesScroll(): void {
    if (!messagesEl) return
    const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
    stickToBottom = distanceFromBottom < BOTTOM_THRESHOLD_PX
  }

  $effect(() => {
    // Deep-read every mutable field so this reruns on each streamed token
    // (text_delta appends, tool_use_delta/tool_result updates in place),
    // not just when a whole new message/segment object is pushed.
    for (const m of messages) {
      for (const s of m.segments) {
        void s.text
        void s.toolCall?.input
        void s.toolCall?.result
      }
    }
    if (!stickToBottom) return
    tick().then(() => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
    })
  })

  /** `null` = Auto (orchestrator decides). Sticky across sends until cycled again. */
  let forcedRole: AgentRole | null = $state(null)
  const MODE_CYCLE: (AgentRole | null)[] = [null, ...AGENT_ROLES]

  function cycleMode(direction: 1 | -1): void {
    const idx = MODE_CYCLE.indexOf(forcedRole)
    forcedRole = MODE_CYCLE[(idx + direction + MODE_CYCLE.length) % MODE_CYCLE.length]
  }

  function modeLabel(role: AgentRole | null): string {
    return role ? AGENT_ROLE_LABELS[role] : 'Auto'
  }

  function submit(): void {
    const text = draft.trim()
    if (!text || sending) return
    draft = ''
    stickToBottom = true
    onSend(text, forcedRole)
  }

  function toggleExpand(id: string): void {
    expandedIds[id] = !expandedIds[id]
  }

  // Long pasted/typed user input renders as one huge bubble otherwise —
  // collapse it to a short preview with a click-to-expand toggle. Display
  // only: the full text is still what gets sent to the model and stored.
  function previewOf(text: string): { text: string; truncated: boolean } {
    const lines = text.split('\n')
    let preview = lines.length > PREVIEW_MAX_LINES ? lines.slice(0, PREVIEW_MAX_LINES).join('\n') : text
    if (preview.length > PREVIEW_MAX_CHARS) preview = preview.slice(0, PREVIEW_MAX_CHARS)
    return { text: preview, truncated: preview.length < text.length }
  }
</script>

<div class="chat-view">
  <div class="messages" bind:this={messagesEl} onscroll={onMessagesScroll}>
    {#if messages.length === 0}
      <p class="placeholder">Say hello to get started.</p>
    {/if}
    {#each messages as message (message.id)}
      <div class="bubble {message.role}">
        {#each message.segments as segment, i (segment.id)}
          {@const prevRole = i > 0 ? message.segments[i - 1].agentRole : undefined}
          {#if segment.agentRole && segment.agentRole !== prevRole}
            <div class="agent-chip">{AGENT_ROLE_LABELS[segment.agentRole]} agent</div>
          {/if}
          {#if segment.kind === 'tool' && segment.toolCall}
            {@const isDelegate = segment.toolCall.name.startsWith('delegate_to_')}
            <div class="tool-call">
              <div class="tool-call-head">
                <span class="tool-icon">⚙</span>
                <code>{segment.toolCall.name}</code>
                <span class="tool-input">{segment.toolCall.input}</span>
              </div>
              {#if !isDelegate}
                {#if segment.toolCall.result !== undefined}
                  <div class="tool-result" class:error={segment.toolCall.isError}>{segment.toolCall.result}</div>
                {:else}
                  <div class="tool-result pending">Waiting for confirmation...</div>
                {/if}
              {:else if segment.toolCall.result === undefined}
                {@const delegateRole = segment.toolCall.name.slice('delegate_to_'.length).replaceAll('_', '-')}
                <!-- Delegate calls need no confirmation and no result box of their own —
                     the specialist's own attributed segments right below already show the
                     answer; showing it again here (the tool_result content the outer model
                     needs for its own context) would just duplicate it. Naming the actual
                     target role (not the raw "Working...") is the orchestrator's own routing
                     decision surfacing as a real, live status instead of another dead pause. -->
                <div class="tool-result pending">
                  Delegating to {(AGENT_ROLE_LABELS as Record<string, string>)[delegateRole] ?? delegateRole} agent…
                </div>
              {/if}
            </div>
          {:else if segment.kind === 'text'}
            {#if message.role === 'user'}
              {@const preview = previewOf(segment.text ?? '')}
              {@const expanded = Boolean(expandedIds[segment.id])}
              <span class="text"
                >{expanded ? segment.text : preview.text}{#if preview.truncated && !expanded}…{/if}</span
              >
              {#if preview.truncated}
                <button class="expand-toggle" onclick={() => toggleExpand(segment.id)}>
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              {/if}
            {:else}
              <MarkdownText text={segment.text ?? ''} />
            {/if}
          {/if}
        {/each}
        {#if message.pending}
          {@const last = message.segments[message.segments.length - 1]}
          {@const lastIsUnresolvedTool = last?.kind === 'tool' && last.toolCall?.result === undefined}
          {#if last?.kind === 'text'}
            <!-- Actively streaming text is its own live indicator. -->
            <span class="text cursor">▌</span>
          {:else if !lastIsUnresolvedTool}
            <!-- No segment yet, or the last one already finished (e.g. a
                 resolved tool result) and the next round hasn't produced
                 anything visible yet — show the backend's real per-round
                 status instead of a dead pause. An in-flight tool/delegate
                 call is skipped here since its own box already carries a
                 pending label ("Waiting for confirmation...", "Delegating
                 to X agent…") — this would just duplicate it. -->
            <span class="thinking">{message.statusText ?? 'Thinking…'}</span>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  <div class="composer-area">
    <form class="composer" onsubmit={(e) => (e.preventDefault(), submit())}>
      <textarea
        bind:value={draft}
        placeholder="Message Sachivji..."
        disabled={sending}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Tab' && e.ctrlKey) {
            // Cmd+Tab is the OS app-switcher and can't be intercepted by any app,
            // hence Ctrl+Tab here — capturable within a focused field, and the
            // same convention browsers/editors already use for cycling tabs.
            e.preventDefault()
            cycleMode(e.shiftKey ? -1 : 1)
          }
        }}
      ></textarea>
      {#if sending}
        <button class="send stop" type="button" onclick={onStop} aria-label="Stop generating">⏹</button>
      {:else}
        <button class="send" type="submit" disabled={!draft.trim()} aria-label="Send">↵</button>
      {/if}
    </form>

    <div class="status-bar">
      <div class="status-left">
        <span class="status-text">{statusLine}</span>
        <button
          class="mode-picker"
          class:pinned={forcedRole !== null}
          onclick={() => cycleMode(1)}
          title={forcedRole !== null
            ? `Pinned to ${modeLabel(forcedRole)} — this agent alone, no auto hand-off to others. Click or Ctrl+Tab to cycle, Ctrl+Shift+Tab to reverse.`
            : 'Ctrl+Tab to cycle agent, Ctrl+Shift+Tab to reverse'}
        >
          <span class="dot"></span>
          Agent: {modeLabel(forcedRole)}
        </button>
        {#if model}
          <ContextMeter {model} inputTokens={sessionUsage.inputTokens} outputTokens={sessionUsage.outputTokens} />
        {/if}
      </div>
      <ModelPicker
        {providers}
        {providerId}
        {model}
        {hasKey}
        {onChangeProvider}
        {onChangeModel}
        {onNeedKey}
      />
    </div>
  </div>
</div>

<style>
  .chat-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .placeholder {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .bubble {
    max-width: 70%;
    padding: 0.55rem 0.8rem;
    border-radius: 12px;
    white-space: pre-wrap;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .bubble.user {
    align-self: flex-end;
    background: var(--user-bubble);
  }
  .bubble.assistant {
    align-self: flex-start;
    background: var(--panel);
  }
  .agent-chip {
    display: inline-block;
    margin-bottom: 0.3rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--accent);
    font-size: 0.7rem;
    font-weight: 600;
  }
  .bubble.assistant :global(.markdown-body) {
    white-space: normal;
  }
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
  .cursor {
    color: var(--text-muted);
  }
  /* Shown only before the first segment of a reply arrives — otherwise the
     bubble is just an empty box with a lone blinking cursor in it, with no
     indication anything is happening (the default local model has a long
     silent "thinking" phase before its first token). Once real content
     (text or a tool call) starts, this is replaced by that content plus
     the normal trailing .cursor, not shown alongside it. */
  .thinking {
    display: inline-block;
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.9rem;
    animation: thinking-pulse 1.4s ease-in-out infinite;
  }
  @keyframes thinking-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }
  .expand-toggle {
    display: block;
    margin-top: 0.35rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
  }
  .expand-toggle:hover {
    text-decoration: underline;
  }
  .tool-call {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.65rem;
    margin-bottom: 0.4rem;
    font-size: 0.78rem;
  }
  .tool-call-head {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    color: var(--text-muted);
  }
  .tool-icon {
    color: var(--accent);
  }
  .tool-call-head code {
    color: var(--text);
    font-family: ui-monospace, monospace;
  }
  .tool-input {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
  }
  .tool-result {
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    color: var(--text-muted);
  }
  .tool-result.pending {
    font-style: italic;
  }
  .tool-result.error {
    color: var(--warn);
  }
  .composer-area {
    padding: 0.75rem 1.25rem 0.6rem;
    border-top: 1px solid var(--border);
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 0.6rem 0.6rem 0.6rem 1.1rem;
  }
  textarea {
    flex: 1;
    resize: none;
    height: 2.4rem;
    padding: 0.35rem 0;
    border: none;
    background: none;
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
  }
  textarea:focus {
    outline: none;
  }
  .send {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: #1a1a1a;
    cursor: pointer;
    font-size: 1rem;
    flex-shrink: 0;
  }
  /* ToolConfirmDialog's overlay is `position: fixed; inset: 0; z-index: 20`
     — a normal-flow sibling like this button sits below any positioned,
     z-indexed element regardless of DOM order, so without this the overlay
     physically intercepts every click on Stop while a confirmation dialog
     is open, however visible the button still looks underneath it. Found
     live: Stop did nothing while waiting on a tool confirmation. */
  .send.stop {
    position: relative;
    z-index: 30;
  }
  .send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.25rem 0;
  }
  .status-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .status-text {
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .mode-picker {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
  }
  .mode-picker:hover {
    background: var(--panel-hover);
    color: var(--text);
  }
  .mode-picker .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  /* Pinned away from "Auto" changes what the app can do (no delegation, no
     orchestrator) — worth standing out from the rest of the muted status
     bar rather than reading as just another status label. Found live: a
     session stayed pinned to one specialist across several unrelated
     follow-ups without the user noticing. */
  .mode-picker.pinned {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
</style>
