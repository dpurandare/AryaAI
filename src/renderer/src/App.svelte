<script lang="ts">
  import SessionList from './lib/components/SessionList.svelte'
  import ChatView from './lib/components/ChatView.svelte'

  let statusLine = $state('Connecting to main process...')

  window.sachiv
    .getAppInfo()
    .then((info) => {
      statusLine = `Sachiv v${info.version} — ${info.platform}`
    })
    .catch((err: unknown) => {
      statusLine = `IPC error: ${String(err)}`
    })
</script>

<main>
  <aside>
    <SessionList sessions={[]} activeId="" />
  </aside>
  <section>
    <ChatView {statusLine} />
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #1e1e1e;
    color: #e6e6e6;
  }
  main {
    display: grid;
    grid-template-columns: 260px 1fr;
    height: 100vh;
  }
</style>
