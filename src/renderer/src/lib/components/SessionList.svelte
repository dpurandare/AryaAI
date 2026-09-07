<script lang="ts">
  interface Session {
    id: string
    title: string
  }

  let { sessions = [], activeId = '' }: { sessions: Session[]; activeId: string } = $props()
</script>

<div class="session-list">
  <div class="header">Sessions</div>
  <ul>
    {#each sessions as session (session.id)}
      <li class:active={session.id === activeId}>{session.title}</li>
    {:else}
      <li class="empty">No sessions yet</li>
    {/each}
  </ul>
</div>

<style>
  .session-list {
    height: 100%;
    overflow-y: auto;
    border-right: 1px solid var(--border, #2a2a2a);
  }
  .header {
    padding: 0.75rem 1rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.875rem;
  }
  li.active {
    background: var(--accent-bg, rgba(255, 255, 255, 0.08));
  }
  li.empty {
    opacity: 0.5;
    cursor: default;
  }
</style>
