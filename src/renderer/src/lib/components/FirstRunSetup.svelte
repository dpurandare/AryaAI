<script lang="ts">
  let {
    envFilePath,
    onChooseKeychain,
    onChooseFile
  }: {
    envFilePath: string
    onChooseKeychain: () => void
    onChooseFile: () => Promise<void>
  } = $props()

  let switching = $state(false)
  let showFileConfirm = $state(false)

  async function confirmFile(): Promise<void> {
    switching = true
    try {
      await onChooseFile()
    } finally {
      switching = false
    }
  }
</script>

<div class="screen">
  <div class="panel">
    <h1>Welcome to Sachivji</h1>
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
      <button class="primary" onclick={onChooseKeychain}>Continue with OS Keychain</button>
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
