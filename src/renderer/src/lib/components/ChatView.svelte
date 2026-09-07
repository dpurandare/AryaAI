<script lang="ts">
  let { statusLine = '' }: { statusLine: string } = $props()
</script>

<div class="chat-view">
  <div class="messages">
    <p class="placeholder">Chat will appear here once the Orchestrator is wired up.</p>
  </div>
  <div class="status-bar">{statusLine}</div>
</div>

<style>
  .chat-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
  }
  .placeholder {
    opacity: 0.5;
    font-size: 0.9rem;
  }
  .status-bar {
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    opacity: 0.6;
    border-top: 1px solid var(--border, #2a2a2a);
  }
</style>
