<script lang="ts">
  import type { AppInfo } from '@shared/ipc-contract'
  import illustration from '../../assets/splash-illustration.png'

  let {
    info,
    dismissible = false,
    onClose
  }: {
    info: AppInfo | null
    /** false during the startup splash (no close affordance — the caller dismisses it once the app has loaded); true for the About screen, reusing the same layout with a close button and runtime details. */
    dismissible?: boolean
    onClose?: () => void
  } = $props()

  function onBackdropClick(e: MouseEvent): void {
    if (dismissible && e.target === e.currentTarget) onClose?.()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (dismissible && e.key === 'Escape') onClose?.()
  }
</script>

<svelte:window onkeydown={dismissible ? onKeydown : undefined} />

<div
  class="splash"
  class:overlay={dismissible}
  onclick={onBackdropClick}
  role={dismissible ? 'dialog' : undefined}
  aria-modal={dismissible ? 'true' : undefined}
  aria-label={dismissible ? 'About Sachivji' : undefined}
>
  <div class="panel">
    {#if dismissible}
      <button class="close" onclick={() => onClose?.()} aria-label="Close">✕</button>
    {/if}
    <img class="hero" src={illustration} alt="Sachivji" />
    <div class="identity">
      <h1>{info?.name ?? 'Sachivji'}</h1>
      <span class="version-badge">v{info?.version ?? '…'}</span>
    </div>
    <p class="tagline">Your local-first, multi-agent AI companion.</p>
    {#if dismissible && info}
      <hr />
      <dl class="details">
        <dt>Platform</dt>
        <dd>{info.platform}</dd>
        <dt>Electron</dt>
        <dd>{info.electronVersion}</dd>
        <dt>Chromium</dt>
        <dd>{info.chromeVersion}</dd>
        <dt>Node</dt>
        <dd>{info.nodeVersion}</dd>
        <dt>User</dt>
        <dd>{info.userName}</dd>
      </dl>
    {:else if !dismissible}
      <p class="loading"><span class="dot"></span>Starting…</p>
    {/if}
  </div>
</div>

<style>
  .splash {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    background: var(--bg);
  }
  .splash.overlay {
    background: rgba(0, 0, 0, 0.5);
  }
  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2rem 2.5rem;
    text-align: center;
  }
  .splash.overlay .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    min-width: 320px;
  }
  .close {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1rem;
    cursor: pointer;
    padding: 0.3rem;
    line-height: 1;
  }
  .close:hover {
    color: var(--text);
  }
  /* The source illustration is 1024x1024 — shown at roughly a fifth of that, per request. */
  .hero {
    width: 205px;
    height: 205px;
    object-fit: cover;
    border-radius: 16px;
    border: 1px solid var(--border);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
    margin-bottom: 0.4rem;
  }
  .identity {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  .version-badge {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: var(--panel-hover);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .tagline {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
    max-width: 280px;
  }
  .loading {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0.9rem 0 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
  hr {
    width: 100%;
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.6rem 0 0.2rem;
  }
  .details {
    margin: 0;
    display: grid;
    grid-template-columns: auto auto;
    gap: 0.3rem 1rem;
    font-size: 0.75rem;
    text-align: left;
  }
  .details dt {
    color: var(--text-muted);
  }
  .details dd {
    margin: 0;
    color: var(--text);
  }
</style>
