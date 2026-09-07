<script lang="ts">
  import ModelPicker from './ModelPicker.svelte'

  interface ToolCallDisplay {
    id: string
    name: string
    input: string
    result?: string
    isError?: boolean
  }

  interface DisplayMessage {
    id: string
    role: 'user' | 'assistant'
    text: string
    pending?: boolean
    toolCalls?: ToolCallDisplay[]
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
    providers,
    providerId,
    model,
    hasKey,
    onChangeProvider,
    onChangeModel,
    onNeedKey
  }: {
    messages: DisplayMessage[]
    statusLine: string
    sending: boolean
    onSend: (text: string) => void
    providers: readonly Provider[]
    providerId: string
    model: string
    hasKey: boolean
    onChangeProvider: (id: string) => void
    onChangeModel: (model: string) => void
    onNeedKey: () => void
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

  function submit(): void {
    const text = draft.trim()
    if (!text || sending) return
    draft = ''
    onSend(text)
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
  <div class="messages">
    {#if messages.length === 0}
      <p class="placeholder">Say hello to get started.</p>
    {/if}
    {#each messages as message (message.id)}
      <div class="bubble {message.role}">
        {#each message.toolCalls ?? [] as call (call.id)}
          <div class="tool-call">
            <div class="tool-call-head">
              <span class="tool-icon">⚙</span>
              <code>{call.name}</code>
              <span class="tool-input">{call.input}</span>
            </div>
            {#if call.result !== undefined}
              <div class="tool-result" class:error={call.isError}>{call.result}</div>
            {:else}
              <div class="tool-result pending">Waiting for confirmation...</div>
            {/if}
          </div>
        {/each}
        {#if message.text || !message.toolCalls?.length}
          {#if message.role === 'user'}
            {@const preview = previewOf(message.text)}
            {@const expanded = Boolean(expandedIds[message.id])}
            <span class="text">{expanded ? message.text : preview.text}{#if preview.truncated && !expanded}…{/if}</span>
            {#if preview.truncated}
              <button class="expand-toggle" onclick={() => toggleExpand(message.id)}>
                {expanded ? 'Show less' : 'Show more'}
              </button>
            {/if}
          {:else}
            <span class="text">{message.text}{#if message.pending}▌{/if}</span>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  <div class="composer-area">
    <form class="composer" onsubmit={(e) => (e.preventDefault(), submit())}>
      <textarea
        bind:value={draft}
        placeholder="Message Sachiv..."
        disabled={sending}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      ></textarea>
      <button class="send" type="submit" disabled={sending || !draft.trim()} aria-label="Send">↵</button>
    </form>

    <div class="status-bar">
      <span class="status-text">{statusLine}</span>
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
    color: #e0a24a;
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
  .status-text {
    font-size: 0.72rem;
    color: var(--text-muted);
  }
</style>
