<script lang="ts">
  import { onMount } from 'svelte'

  let { title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void } = $props()

  let cancelButton: HTMLButtonElement | undefined = $state()
  // Focus starts on Cancel, so an accidental Enter or click never deletes.
  onMount(() => cancelButton?.focus())
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onCancel()} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onCancel()}>
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="del-title" aria-describedby="del-body">
    <h2 id="del-title">Delete this chat?</h2>
    <p id="del-body">
      <strong>{title}</strong> will be deleted permanently, with its messages, saved usage and search-index entries. This cannot be undone. Use the ⇩
      button on the row first if you want to keep a copy.
    </p>
    <div class="buttons">
      <button type="button" bind:this={cancelButton} onclick={onCancel}>Cancel</button>
      <button type="button" class="danger" onclick={onConfirm}>Delete</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .dialog {
    width: min(26rem, calc(100vw - 2rem));
    padding: 1.1rem 1.25rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: 1rem;
  }
  p {
    margin: 0 0 1rem;
    font-size: 0.85rem;
    line-height: 1.45;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  strong {
    color: var(--text);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  button {
    padding: 0.35rem 0.9rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: none;
    color: var(--text);
    font-size: 0.82rem;
    cursor: pointer;
  }
  button:hover,
  button:focus-visible {
    background: var(--panel-hover);
  }
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
