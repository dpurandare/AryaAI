<script lang="ts">
  let {
    name,
    description,
    input,
    secretFields,
    hasValidation,
    autoApprove,
    autoApproveTool,
    onApprove,
    onDeny,
    onValidate,
    onToggleAutoApprove,
    onToggleAutoApproveTool
  }: {
    name: string
    description: string
    input: Record<string, unknown>
    secretFields: string[]
    hasValidation: boolean
    autoApprove: boolean
    autoApproveTool: boolean
    onApprove: (input: Record<string, unknown>) => void
    onDeny: () => void
    onValidate: (input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
    onToggleAutoApprove: (value: boolean) => void
    onToggleAutoApproveTool: (value: boolean) => void
  } = $props()

  // Secret fields never appear in the editable JSON textarea — kept in
  // their own real password inputs instead, merged back in only at the
  // moment of approval (see combinedInput()). This is what keeps a secret
  // out of anything the model could see or that gets persisted.
  const visibleInput = Object.fromEntries(Object.entries(input).filter(([key]) => !secretFields.includes(key)))
  let editedJson = $state(JSON.stringify(visibleInput, null, 2))
  let jsonError = $state('')
  let secretValues = $state<Record<string, string>>(Object.fromEntries(secretFields.map((f) => [f, ''])))
  let validating = $state(false)
  let validationError = $state('')

  function combinedInput(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(editedJson) as Record<string, unknown>
      jsonError = ''
      for (const field of secretFields) {
        if (secretValues[field]) parsed[field] = secretValues[field]
      }
      return parsed
    } catch {
      jsonError = 'Input is not valid JSON.'
      return null
    }
  }

  async function approve(): Promise<void> {
    const merged = combinedInput()
    if (!merged) return

    if (hasValidation) {
      validating = true
      validationError = ''
      const result = await onValidate(merged)
      validating = false
      if (!result.ok) {
        validationError = result.error ?? 'Validation failed.'
        return
      }
    }
    onApprove(merged)
  }
</script>

<div class="overlay" role="presentation">
  <div class="panel" role="alertdialog" aria-modal="true" aria-label="Tool call confirmation">
    <h2>Run <code>{name}</code>?</h2>
    <p class="description">{description}</p>
    <textarea class="json" bind:value={editedJson} spellcheck="false"></textarea>
    {#if jsonError}<p class="error">{jsonError}</p>{/if}

    {#each secretFields as field (field)}
      <label class="secret-field">
        {field}
        <input type="password" bind:value={secretValues[field]} autocomplete="new-password" />
      </label>
    {/each}
    {#if validationError}<p class="error">{validationError}</p>{/if}

    <label class="auto-approve">
      <input
        type="checkbox"
        checked={autoApprove}
        onchange={(e) => onToggleAutoApprove((e.target as HTMLInputElement).checked)}
      />
      Auto-approve tool calls for this session
    </label>
    <label class="auto-approve">
      <input
        type="checkbox"
        checked={autoApproveTool}
        onchange={(e) => onToggleAutoApproveTool((e.target as HTMLInputElement).checked)}
      />
      Always auto-approve <code>{name}</code>
    </label>

    <div class="actions">
      <button onclick={onDeny}>Deny</button>
      <button class="primary" onclick={approve} disabled={validating}>
        {validating ? 'Validating…' : 'Approve'}
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
    color: var(--warn);
  }
  .secret-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .secret-field input {
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 0.85rem;
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
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
