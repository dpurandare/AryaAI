<script lang="ts">
  interface Session {
    id: string
    title: string
  }

  let {
    sessions = [],
    activeId = '',
    onSelect,
    onNew,
    onDelete
  }: {
    sessions: Session[]
    activeId: string
    onSelect: (id: string) => void
    onNew: () => void
    onDelete: (id: string) => void
  } = $props()
</script>

<div class="session-list">
  <button class="new-btn" onclick={onNew}>
    <span class="plus">+</span> New chat
  </button>

  <div class="section-label">Sessions</div>
  <ul>
    {#each sessions as session (session.id)}
      <li class:active={session.id === activeId}>
        <button class="title" onclick={() => onSelect(session.id)}>{session.title}</button>
        {#if session.id !== activeId}
          <button class="delete" title="Delete session" onclick={() => onDelete(session.id)}>×</button>
        {/if}
      </li>
    {:else}
      <li class="empty">No sessions yet</li>
    {/each}
  </ul>
</div>

<style>
  .session-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 0.75rem 0.5rem 0;
  }
  .new-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-radius: 8px;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    font-size: 0.87rem;
    font-weight: 500;
    margin-bottom: 1rem;
  }
  .new-btn:hover {
    background: var(--panel-hover);
  }
  .plus {
    font-size: 1rem;
    line-height: 1;
    color: var(--accent);
  }
  .section-label {
    padding: 0 0.6rem 0.45rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 8px;
    font-size: 0.86rem;
    margin-bottom: 0.1rem;
  }
  li:hover {
    background: var(--panel-hover);
  }
  li.active {
    background: var(--panel);
  }
  li.empty {
    color: var(--text-muted);
    padding: 0.5rem;
  }
  .title {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 0.5rem 0.6rem;
    cursor: pointer;
    font-size: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delete {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 0 0.6rem;
  }
  .delete:hover {
    color: var(--text);
  }
</style>
