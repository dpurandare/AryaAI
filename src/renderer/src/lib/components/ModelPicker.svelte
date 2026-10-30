<script lang="ts">
  interface Provider {
    id: string
    displayName: string
    /** #214: false = a local server that is not answering ("Ollama (local)" when Ollama is not running). */
    available?: boolean
    unavailableMessage?: string
    fallback?: { providerId: string; displayName: string; model: string }
  }

  let {
    providers,
    providerId,
    model,
    hasKey,
    onChangeProvider,
    onChangeModel,
    onNeedKey
  }: {
    providers: readonly Provider[]
    providerId: string
    model: string
    hasKey: boolean
    onChangeProvider: (id: string) => void
    onChangeModel: (model: string) => void
    onNeedKey: () => void
  } = $props()

  let open = $state(false)
  let rootEl: HTMLDivElement | undefined = $state()
  let models = $state<string[]>([])
  let loadingModels = $state(false)
  let modelsError = $state('')
  let manualModel = $state('')

  const currentProvider = $derived(providers.find((p) => p.id === providerId))
  const currentProviderName = $derived(currentProvider?.displayName ?? providerId)
  const currentUnavailable = $derived(currentProvider?.available === false)
  /** #225: the provider is down but a consented cloud fallback will answer: show what will actually answer, not an error. */
  const currentFallback = $derived(currentUnavailable ? currentProvider?.fallback : undefined)

  $effect(() => {
    manualModel = model
  })

  $effect(() => {
    if (!open) return
    // Re-run whenever providerId/hasKey change while the popover is open.
    const id = providerId
    const key = hasKey
    models = []
    modelsError = ''
    if (!key) return
    if (currentUnavailable) {
      modelsError = currentProvider?.unavailableMessage ?? `${currentProviderName} is not running.`
      return
    }
    loadingModels = true
    window.sachiv
      .listModels(id)
      .then((list) => {
        models = list
      })
      .catch((err: unknown) => {
        modelsError = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        loadingModels = false
      })
  })

  function commitManualModel(): void {
    if (manualModel.trim()) onChangeModel(manualModel.trim())
  }

  // A click anywhere outside the picker (or Escape) closes the popover; clicks on the trigger are handled by its own toggle.
  function onWindowPointerDown(e: PointerEvent): void {
    if (open && rootEl && !rootEl.contains(e.target as Node)) open = false
  }
  function onWindowKeydown(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') open = false
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div class="model-picker" bind:this={rootEl}>
  <button class="trigger" onclick={() => (open = !open)}>
    <span class="dot"></span>
    {#if currentFallback}{currentFallback.displayName} · {currentFallback.model} · fallback for {currentProviderName}{:else}{currentProviderName}{currentUnavailable ? ' (not running)' : ''} · {model || 'no model set'}{/if}
  </button>

  {#if open}
    <div class="popover">
      <div class="row">
        <span class="label">Provider</span>
        <select
          value={providerId}
          onchange={(e) => onChangeProvider((e.target as HTMLSelectElement).value)}
        >
          {#each providers as p (p.id)}
            <option value={p.id}>{p.displayName}{p.available === false ? ' (not running)' : ''}</option>
          {/each}
        </select>
      </div>

      {#if !hasKey}
        <button
          class="link"
          onclick={() => {
            open = false
            onNeedKey()
          }}
        >
          Add an API key for {currentProviderName}...
        </button>
      {:else if loadingModels}
        <p class="hint">Loading models...</p>
      {:else if models.length > 0}
        <div class="row">
          <span class="label">Model</span>
          <select value={model} onchange={(e) => onChangeModel((e.target as HTMLSelectElement).value)}>
            {#each models as m (m)}
              <option value={m}>{m}</option>
            {/each}
          </select>
        </div>
      {:else}
        {#if modelsError}<p class="hint error">Couldn't list models — enter one manually.</p>{/if}
        <input
          type="text"
          placeholder="model id"
          bind:value={manualModel}
          onblur={commitManualModel}
          onkeydown={(e) => e.key === 'Enter' && commitManualModel()}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-picker {
    position: relative;
  }
  .trigger {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.3rem 0.65rem;
    border-radius: 999px;
  }
  .trigger:hover {
    background: var(--panel-hover);
    color: var(--text);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .popover {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    right: 0;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.75rem;
    width: 260px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 10;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .label {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  select,
  input {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 0.4rem;
    font-size: 0.8rem;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .hint.error {
    color: var(--warn);
  }
  .link {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    padding: 0;
  }
</style>
