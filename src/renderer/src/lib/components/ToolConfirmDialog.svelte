<script lang="ts">
  let {
    name,
    description,
    input,
    autoApprove,
    onApprove,
    onDeny,
    onToggleAutoApprove
  }: {
    name: string
    description: string
    input: Record<string, unknown>
    autoApprove: boolean
    onApprove: (input: Record<string, unknown>) => void
    onDeny: () => void
    onToggleAutoApprove: (value: boolean) => void
  } = $props()

  let editedJson = $state(JSON.stringify(input, null, 2))
  let jsonError = $state('')

  function approve(): void {
    try {
      const parsed = JSON.parse(editedJson) as Record<string, unknown>
      jsonError = ''
      onApprove(parsed)
    } catch {
      jsonError = 'Input is not valid JSON.'
    }
  }
</script>

<div class="overlay" role="presentation">
  <div class="panel" role="alertdialog" aria-modal="true" aria-label="Tool call confirmation">
    <h2>Run <code>{name}</code>?</h2>
    <p class="description">{description}</p>
    <textarea class="json" bind:value={editedJson} spellcheck="false"></textarea>
    {#if jsonError}<p class="error">{jsonError}</p>{/if}

    <label class="auto-approve">
      <input
        type="checkbox"
        checked={autoApprove}
        onchange={(e) => onToggleAutoApprove((e.target as HTMLInputElement).checked)}
      />
      Auto-approve tool calls for this session
    </label>

    <div class="actions">
      <button onclick={onDeny}>Deny</button>
      <button class="primary" onclick={approve}>Approve</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
    width: 420px;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  code {
    background: var(--panel-hover);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .description {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .json {
    resize: vertical;
    min-height: 6rem;
    padding: 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .error {
    margin: 0;
    font-size: 0.78rem;
    color: #e0a24a;
  }
  .auto-approve {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  button {
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-hover);
    color: var(--text);
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
    font-weight: 600;
  }
</style>
