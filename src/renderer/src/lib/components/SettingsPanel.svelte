<script lang="ts">
  let {
    providerDisplayName,
    hasKey,
    onSave,
    onClose
  }: {
    providerDisplayName: string
    hasKey: boolean
    onSave: (apiKey: string) => void | Promise<void>
    onClose: () => void
  } = $props()

  let apiKey = $state('')
  let saving = $state(false)

  async function save(): Promise<void> {
    if (!apiKey.trim()) return
    saving = true
    await onSave(apiKey.trim())
    saving = false
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={onClose}
  onkeydown={(e) => e.key === 'Escape' && onClose()}
>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <h2>{providerDisplayName} API key</h2>
    <p class="status">
      {hasKey ? 'A key is currently configured.' : 'No key configured yet.'} Pick a different provider
      from the model picker in the chat footer.
    </p>
    <input
      id="anthropic-key"
      type="password"
      placeholder="Paste your API key"
      bind:value={apiKey}
      onkeydown={(e) => e.key === 'Enter' && save()}
    />
    <div class="actions">
      <button onclick={onClose}>Cancel</button>
      <button class="primary" disabled={saving || !apiKey.trim()} onclick={save}>
        {saving ? 'Saving...' : 'Save'}
      </button>
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
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
    width: 320px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  h2 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }
  .status {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  input {
    padding: 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
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
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
