<script lang="ts">
  import type { OllamaRuntimeState, RuntimeState } from '@shared/runtime'

  let {
    envFilePath,
    initialStep = 'secrets',
    onChooseKeychain,
    onChooseFile,
    onFinish
  }: {
    envFilePath: string
    /** `'python'` when the secret-storage choice was already made in an earlier launch. */
    initialStep?: 'secrets' | 'python'
    onChooseKeychain: () => Promise<void>
    onChooseFile: () => Promise<void>
    /** Called once the Python runtime is ready, or the user chose to continue without it. */
    onFinish: () => Promise<void>
  } = $props()

  // svelte-ignore state_referenced_locally
  let step = $state<'secrets' | 'python' | 'ollama'>(initialStep)
  let switching = $state(false)
  let showFileConfirm = $state(false)

  async function confirmFile(): Promise<void> {
    switching = true
    try {
      await onChooseFile()
      step = 'python'
    } finally {
      switching = false
    }
  }

  async function chooseKeychain(): Promise<void> {
    await onChooseKeychain()
    step = 'python'
  }

  // --- Python step: the onboarding gate (design-discussion.md 4.3) ---
  let runtime = $state<RuntimeState | null>(null)
  let busy = $state(false)

  window.sachiv.getRuntimeState().then((s) => {
    if (s) runtime = s
  })
  $effect(() => window.sachiv.onRuntimeStateChanged((s) => (runtime = s)))

  // Usable as soon as the venv works; base packages may still be installing in the background.
  const canContinue = $derived(runtime?.status === 'ready' || runtime?.status === 'disabled')
  const needsAttention = $derived(runtime?.status === 'missing-python' || runtime?.status === 'failed')

  async function retry(): Promise<void> {
    busy = true
    try {
      runtime = await window.sachiv.ensureRuntime()
    } finally {
      busy = false
    }
  }

  async function continueWithoutPython(): Promise<void> {
    busy = true
    try {
      await window.sachiv.setRuntimeEnabled(false)
      await afterPython()
    } finally {
      busy = false
    }
  }

  // --- Ollama step: the Windows sponsor build's bundled, CPU-only server (TASKS #202).
  // `status === 'unavailable'` on every other build/platform, including a win32 build without
  // the bundled resource — this step is then skipped entirely, straight to finish(), so nothing
  // changes for anyone outside that one specific build. Tracked from mount (not step-gated) so
  // by the time the Python step's Continue is clicked, the current status is already known —
  // no extra round trip, no flash of a step that's about to be skipped.
  let ollama = $state<OllamaRuntimeState | null>(null)

  window.sachiv.getOllamaRuntimeState().then((s) => {
    if (s) ollama = s
  })
  $effect(() => window.sachiv.onOllamaRuntimeStateChanged((s) => (ollama = s)))

  const ollamaReady = $derived(ollama?.status === 'ready')
  const ollamaFailed = $derived(ollama?.status === 'failed')
  const ollamaPullPercent = $derived(
    ollama?.modelPullProgress ? Math.round((100 * ollama.modelPullProgress.completed) / ollama.modelPullProgress.total) : undefined
  )

  async function afterPython(): Promise<void> {
    if (!ollama || ollama.status === 'unavailable') {
      await finish()
      return
    }
    step = 'ollama'
  }

  async function retryOllama(): Promise<void> {
    busy = true
    try {
      ollama = await window.sachiv.ensureOllamaRuntime()
    } finally {
      busy = false
    }
  }

  async function finish(): Promise<void> {
    busy = true
    try {
      await onFinish()
    } finally {
      busy = false
    }
  }
</script>

<div class="screen">
  <div class="panel">
    <h1>Welcome to Sachivji</h1>

    {#if step === 'secrets'}
      <p>
        Before you start, choose where provider API keys and connection secrets (databases, external APIs,
        MCP servers, email accounts) should be stored. You can leave this on the recommended option — it's
        what most people want.
      </p>

      <div class="option">
        <h2>OS Keychain <span class="badge">Recommended</span></h2>
        <p>
          Encrypted using your operating system's own secure storage (Keychain on macOS, DPAPI on Windows,
          libsecret on Linux). Nothing is ever written in plaintext.
        </p>
        <button class="primary" onclick={chooseKeychain}>Continue with OS Keychain</button>
      </div>

      {#if !showFileConfirm}
        <div class="option">
          <h2>File instead</h2>
          <p>
            Stores secrets in a plain file at <code>{envFilePath}</code> — useful if OS-native secure
            storage isn't available on this machine (e.g. a headless Linux box with no keyring running).
            Less secure than the Keychain: readable by any process/user with access to your files.
          </p>
          <button onclick={() => (showFileConfirm = true)}>Use a file instead</button>
        </div>
      {:else}
        <div class="option">
          <h2>Use a file instead?</h2>
          <p>This is a one-time choice — there's no way to switch back to the Keychain later.</p>
          <div class="actions">
            <button onclick={() => (showFileConfirm = false)}>Cancel</button>
            <button class="primary" disabled={switching} onclick={confirmFile}>
              {switching ? 'Setting up...' : 'Confirm: use a file'}
            </button>
          </div>
        </div>
      {/if}
    {:else if step === 'python'}
      <p>
        Sachivji runs agent-written scripts — charts, Word and Excel files — in a Python environment
        that it sets up inside your workspace. This needs Python 3.10 or newer installed on this
        computer. It is not a sandbox: scripts can read and write anywhere you can.
      </p>

      <div class="option">
        <h2>
          Python
          {#if runtime?.status === 'ready' && runtime.packages !== 'installing'}<span class="badge">Ready</span>{/if}
        </h2>
        {#if runtime}
          <p class:error={needsAttention}>
            {runtime.message}{runtime.pythonVersion ? ` (Python ${runtime.pythonVersion})` : ''}
          </p>
        {:else}
          <p>Checking…</p>
        {/if}
        <div class="actions">
          {#if needsAttention}
            <button disabled={busy} onclick={retry}>Retry</button>
            <button disabled={busy} onclick={continueWithoutPython}>Continue without Python</button>
          {:else}
            <button class="primary" disabled={!canContinue || busy} onclick={afterPython}>
              {canContinue ? 'Continue' : 'Setting up…'}
            </button>
          {/if}
        </div>
      </div>
      {#if needsAttention}
        <p>
          Install Python from python.org (on Debian/Ubuntu: <code>sudo apt install python3 python3-venv</code>),
          then choose Retry. Without Python, chat, database and Office tools still work; you can turn it on
          later in Settings &gt; Runtime.
        </p>
      {/if}
    {:else}
      <p>
        Setting up local search history: a bundled, CPU-only Ollama server for the embedding model it uses.
        This needs to download the <code>nomic-embed-text</code> model (about 274MB) once, over the network.
      </p>

      <div class="option">
        <h2>
          Local embeddings
          {#if ollamaReady}<span class="badge">Ready</span>{/if}
        </h2>
        {#if ollama}
          <p class:error={ollamaFailed}>
            {ollama.message}
            {#if ollama.status === 'pulling-model' && ollamaPullPercent !== undefined}({ollamaPullPercent}%){/if}
          </p>
        {:else}
          <p>Checking…</p>
        {/if}
        <div class="actions">
          {#if ollamaFailed}
            <button disabled={busy} onclick={retryOllama}>Retry</button>
            <button disabled={busy} onclick={finish}>Continue anyway</button>
          {:else}
            <button class="primary" disabled={!ollamaReady || busy} onclick={finish}>
              {ollamaReady ? 'Continue' : 'Setting up…'}
            </button>
          {/if}
        </div>
      </div>
      {#if ollamaFailed}
        <p>
          Local search-history embeddings won't be available. Chat and every other feature still work; you
          can pick a cloud embedding provider instead in Settings &gt; Search History Embedding, or choose
          Retry above.
        </p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .screen {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    z-index: 30;
  }
  .panel {
    max-width: 520px;
    width: 90%;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  h2 {
    margin: 0 0 0.4rem 0;
    font-size: 0.95rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  p {
    margin: 0 0 0.6rem 0;
    font-size: 0.85rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .badge {
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: var(--accent);
    color: #1a1a1a;
  }
  .option {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
  }
  p.error {
    color: var(--danger, #e5484d);
  }
  code {
    background: var(--panel-hover);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
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
