<script lang="ts">
  import SessionList from './lib/components/SessionList.svelte'
  import ChatView from './lib/components/ChatView.svelte'
  import SettingsPanel from './lib/components/SettingsPanel.svelte'
  import { SUPPORTED_PROVIDERS, type SessionDto, type MessageDto } from '@shared/ipc-contract'

  interface DisplayMessage {
    id: string
    role: 'user' | 'assistant'
    text: string
    pending?: boolean
  }

  let statusLine = $state('Connecting...')
  let sessions = $state<SessionDto[]>([])
  let activeId = $state('')
  let messages = $state<DisplayMessage[]>([])
  let sending = $state(false)
  let showSettings = $state(false)
  let providerId = $state('openai')
  let hasKey = $state(false)
  let currentModel = $state('')
  let sidebarCollapsed = $state(false)
  let isMac = $state(false)

  function toDisplay(m: MessageDto): DisplayMessage {
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return { id: m.id, role: m.role, text }
  }

  async function selectSession(id: string): Promise<void> {
    activeId = id
    const records = await window.sachiv.listMessages(id)
    messages = records.map(toDisplay)
  }

  async function loadSessions(): Promise<void> {
    let list = await window.sachiv.listSessions()
    if (list.length === 0) {
      list = [await window.sachiv.createSession('New Chat')]
    }
    sessions = list
    await selectSession(list[0].id)
  }

  async function newSession(): Promise<void> {
    const created = await window.sachiv.createSession('New Chat')
    sessions = [created, ...sessions]
    await selectSession(created.id)
  }

  async function removeSession(id: string): Promise<void> {
    if (id === activeId) return
    await window.sachiv.deleteSession(id)
    sessions = sessions.filter((s) => s.id !== id)
  }

  async function sendMessage(text: string): Promise<void> {
    if (sending) return
    if (!hasKey) {
      showSettings = true
      return
    }
    sending = true

    const userMsg: DisplayMessage = { id: crypto.randomUUID(), role: 'user', text }
    const assistantMsg: DisplayMessage = { id: crypto.randomUUID(), role: 'assistant', text: '', pending: true }
    messages.push(userMsg, assistantMsg)

    const { streamId } = await window.sachiv.sendChatMessage(activeId, text)

    const unsubscribe = window.sachiv.onChatStreamEvent((payload) => {
      if (payload.streamId !== streamId) return
      const event = payload.event
      if (event.type === 'text_delta') {
        assistantMsg.text += event.text
      } else if (event.type === 'error') {
        assistantMsg.text = `Error: ${event.message}`
        assistantMsg.pending = false
        sending = false
        unsubscribe()
      } else if (event.type === 'message_stop') {
        assistantMsg.pending = false
        sending = false
        unsubscribe()
      }
    })
  }

  async function loadProviderState(id: string): Promise<void> {
    hasKey = await window.sachiv.hasApiKey(id)
    currentModel = (await window.sachiv.getSetting(`model:${id}`)) ?? ''
  }

  async function changeProvider(id: string): Promise<void> {
    providerId = id
    await window.sachiv.setSetting('activeProviderId', id)
    await loadProviderState(id)
  }

  async function changeModel(model: string): Promise<void> {
    await window.sachiv.setSetting(`model:${providerId}`, model)
    currentModel = model
  }

  async function saveApiKey(apiKey: string): Promise<void> {
    await window.sachiv.setApiKey(providerId, apiKey)
    await loadProviderState(providerId)
    showSettings = false
  }

  async function initProvider(): Promise<void> {
    providerId = (await window.sachiv.getSetting('activeProviderId')) ?? 'openai'
    await loadProviderState(providerId)
  }

  window.sachiv
    .getAppInfo()
    .then((info) => {
      statusLine = `Sachiv v${info.version}`
      isMac = info.platform === 'darwin'
    })
    .catch((err: unknown) => {
      statusLine = `IPC error: ${String(err)}`
    })

  initProvider()
  loadSessions()
</script>

<div class="titlebar" class:mac={isMac}>
  <button
    class="sidebar-toggle"
    class:mac={isMac}
    title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
    onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.2" />
    </svg>
  </button>
</div>
<main class:sidebar-collapsed={sidebarCollapsed}>
  <aside>
    <SessionList {sessions} {activeId} onSelect={selectSession} onNew={newSession} onDelete={removeSession} />
    <button class="user-row" onclick={() => (showSettings = true)}>
      <span class="avatar">S</span>
      <span class="user-name">Sachiv</span>
      <svg class="chevron" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </aside>
  <section>
    <ChatView
      {messages}
      {statusLine}
      {sending}
      onSend={sendMessage}
      providers={SUPPORTED_PROVIDERS}
      {providerId}
      model={currentModel}
      {hasKey}
      onChangeProvider={changeProvider}
      onChangeModel={changeModel}
      onNeedKey={() => (showSettings = true)}
    />
  </section>
</main>

{#if showSettings}
  <SettingsPanel
    providerDisplayName={SUPPORTED_PROVIDERS.find((p) => p.id === providerId)?.displayName ?? providerId}
    {hasKey}
    onSave={saveApiKey}
    onClose={() => (showSettings = false)}
  />
{/if}

<style>
  :global(:root) {
    --bg: #191919;
    --sidebar-bg: #171717;
    --panel: #262624;
    --panel-hover: #2f2f2d;
    --border: #333331;
    --text: #ececea;
    --text-muted: #8e8e8c;
    --accent: #d97757;
    --user-bubble: #2b2b29;
  }
  :global(html, body) {
    height: 100%;
  }
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    overflow: hidden;
  }
  :global(#app) {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .titlebar {
    -webkit-app-region: drag;
    height: 2.6rem;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    background: var(--sidebar-bg);
    border-bottom: 1px solid var(--border);
  }
  .titlebar.mac {
    padding-left: 5.5rem;
  }
  .sidebar-toggle {
    -webkit-app-region: no-drag;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.8rem;
    height: 1.8rem;
    border: none;
    background: none;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
  }
  .sidebar-toggle:not(.mac) {
    margin-left: 0.75rem;
  }
  .sidebar-toggle:hover {
    background: var(--panel-hover);
    color: var(--text);
  }
  main {
    display: grid;
    grid-template-columns: 260px 1fr;
    flex: 1;
    min-height: 0;
  }
  main.sidebar-collapsed {
    grid-template-columns: 0 1fr;
  }
  aside {
    display: flex;
    flex-direction: column;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  main.sidebar-collapsed aside {
    border-right: none;
  }
  .user-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin: 0.5rem;
    padding: 0.45rem 0.5rem;
    border-radius: 10px;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    font-size: 0.85rem;
    text-align: left;
  }
  .user-row:hover {
    background: var(--panel-hover);
  }
  .user-name {
    flex: 1;
    font-weight: 500;
  }
  .chevron {
    color: var(--text-muted);
    flex-shrink: 0;
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
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
  }
</style>
