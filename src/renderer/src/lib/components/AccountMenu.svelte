<script lang="ts">
  import type { SettingsExportPayload, SettingsImportPreviewItem } from '@shared/ipc-contract'

  let { userName, showSettings, onOpenSettings }: { userName: string; showSettings: boolean; onOpenSettings: () => void } = $props()

  let wrap = $state<HTMLDivElement | undefined>(undefined)
  let open = $state(false)
  let statusMessage = $state('')
  let importPreview = $state<{ payload: SettingsExportPayload; items: SettingsImportPreviewItem[] } | null>(null)
  let applying = $state(false)

  function toggleMenu(): void {
    open = !open
    if (open) statusMessage = ''
  }

  function closeMenu(e: MouseEvent): void {
    if (open && wrap && !wrap.contains(e.target as Node)) open = false
  }

  function selectSettings(): void {
    open = false
    onOpenSettings()
  }

  async function doExport(): Promise<void> {
    open = false
    const result = await window.sachiv.exportSettings()
    if ('error' in result) statusMessage = result.error
    else if (result.cancelled) statusMessage = ''
    else statusMessage = `Exported to ${result.path}`
  }

  async function doImportPreview(): Promise<void> {
    open = false
    const result = await window.sachiv.previewSettingsImport()
    if ('error' in result) {
      statusMessage = result.error
    } else if (!result.cancelled) {
      importPreview = { payload: result.payload, items: result.items }
    }
  }

  function cancelImport(): void {
    importPreview = null
  }

  async function confirmImport(): Promise<void> {
    if (!importPreview) return
    applying = true
    try {
      const { imported, skipped } = await window.sachiv.applySettingsImport(importPreview.payload)
      statusMessage = `Imported ${imported} item${imported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already-configured` : ''}.`
    } finally {
      applying = false
      importPreview = null
    }
  }

  const CATEGORY_LABEL: Record<string, string> = { provider: 'Provider', mcpServer: 'MCP server', dataConnection: 'Data connection' }
</script>

<svelte:window onclick={closeMenu} />

<div class="account-menu-wrap" bind:this={wrap}>
  <button
    class="user-row"
    aria-expanded={open}
    aria-haspopup="menu"
    title="Account"
    onclick={toggleMenu}
  >
    <span class="avatar">{(userName || '?').charAt(0).toUpperCase()}</span>
    <span class="user-name">{userName || 'Account'}</span>
    <svg class="chevron" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if open}
    <div class="menu" role="menu">
      <button type="button" role="menuitem" onclick={selectSettings}>{showSettings ? 'Close settings' : 'Settings'}</button>
      <button type="button" role="menuitem" onclick={doExport}>Export Settings…</button>
      <button type="button" role="menuitem" onclick={doImportPreview}>Import Settings…</button>
    </div>
  {/if}

  {#if statusMessage}
    <p class="status-line">{statusMessage}</p>
  {/if}
</div>

{#if importPreview}
  <div class="import-overlay">
    <div class="import-panel" role="dialog" aria-label="Import settings preview">
      <h2>Import Settings</h2>
      <p class="hint">
        Connection shape only — no API keys, tokens, or database passwords are ever included. An item already
        configured locally is skipped, never overwritten.
      </p>
      <ul class="preview-list">
        {#each importPreview.items as item, i (i)}
          <li class:skip={!item.willImport}>
            <span class="cat">{CATEGORY_LABEL[item.category]}</span>
            <span class="label">{item.label}</span>
            <span class="verdict">{item.willImport ? 'Import' : 'Already configured — skip'}</span>
          </li>
        {/each}
        {#if importPreview.items.length === 0}
          <li class="empty">Nothing in this file to import.</li>
        {/if}
      </ul>
      <div class="actions">
        <button type="button" class="ghost" onclick={cancelImport} disabled={applying}>Cancel</button>
        <button
          type="button"
          class="primary"
          onclick={confirmImport}
          disabled={applying || !importPreview.items.some((i) => i.willImport)}
        >
          {applying ? 'Importing…' : `Import ${importPreview.items.filter((i) => i.willImport).length} item(s)`}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .account-menu-wrap {
    position: relative;
  }
  .user-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    border-radius: 8px;
    text-align: left;
  }
  .user-row:hover {
    background: var(--panel-hover);
  }
  .avatar {
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    background: var(--accent);
    color: #1a1a1a;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
    font-weight: 600;
    flex-shrink: 0;
  }
  .user-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
  }
  .chevron {
    color: var(--text-muted);
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .user-row[aria-expanded='true'] .chevron {
    transform: rotate(180deg);
  }
  .menu {
    position: absolute;
    bottom: 100%;
    left: 0.5rem;
    right: 0.5rem;
    margin-bottom: 0.3rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    padding: 0.3rem;
    z-index: 20;
  }
  .menu button {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border: none;
    background: none;
    color: var(--text);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .menu button:hover {
    background: var(--panel-hover);
  }
  .status-line {
    margin: 0.2rem 0.75rem 0.4rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    word-break: break-all;
  }
  .import-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .import-panel {
    width: min(560px, 90vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.2rem;
  }
  .import-panel h2 {
    margin: 0;
    font-size: 1rem;
  }
  .hint {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .preview-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .preview-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    background: var(--bg);
    font-size: 0.8rem;
  }
  .preview-list li.skip {
    opacity: 0.6;
  }
  .preview-list .cat {
    color: var(--text-muted);
    flex-shrink: 0;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .preview-list .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preview-list .verdict {
    flex-shrink: 0;
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .preview-list .empty {
    justify-content: center;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
    font-weight: 600;
  }
  .actions button {
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-hover);
    color: var(--text);
    cursor: pointer;
  }
  .actions button.ghost {
    background: none;
  }
  .actions button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
