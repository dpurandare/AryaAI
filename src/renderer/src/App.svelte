<script lang="ts">
  import SessionList from './lib/components/SessionList.svelte'
  import ChatView from './lib/components/ChatView.svelte'
  import SettingsPanel from './lib/components/SettingsPanel.svelte'
  import ToolConfirmDialog from './lib/components/ToolConfirmDialog.svelte'
  import {
    type SessionDto,
    type MessageDto,
    type ToolConfirmRequestPayload,
    type ProviderDescriptor
  } from '@shared/ipc-contract'
  import type { AgentRole } from '@shared/agents'

  interface ToolCallDisplay {
    id: string
    name: string
    input: string
    result?: string
    isError?: boolean
  }

  /**
   * A message's content in the order it actually happened. `agentRole` set
   * means a specialist (not the orchestrator itself) produced that segment
   * — see main/agents/orchestrator.ts. Replaces a flat {text, toolCalls}
   * shape so delegated content can be visually attributed and interleaving
   * (text, then a tool call, then more text) renders correctly.
   */
  interface DisplaySegment {
    id: string
    kind: 'text' | 'tool'
    agentRole?: AgentRole
    text?: string
    toolCall?: ToolCallDisplay
  }

  interface DisplayMessage {
    id: string
    role: 'user' | 'assistant'
    pending?: boolean
    segments: DisplaySegment[]
  }

  let statusLine = $state('Connecting...')
  let sessions = $state<SessionDto[]>([])
  let activeId = $state('')
  let messages = $state<DisplayMessage[]>([])
  let sending = $state(false)
  let showSettings = $state(false)
  let providers = $state<ProviderDescriptor[]>([])
  let providerId = $state('openai')
  let hasKey = $state(false)
  let currentModel = $state('')
  let sidebarCollapsed = $state(false)
  let sidebarWidth = $state(260)
  let isMac = $state(false)

  const SIDEBAR_MIN_WIDTH = 180
  const SIDEBAR_MAX_WIDTH = 480

  function startSidebarResize(event: PointerEvent): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth

    function onMove(moveEvent: PointerEvent): void {
      const next = startWidth + (moveEvent.clientX - startX)
      sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next))
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.sachiv.setSetting('sidebarWidth', String(sidebarWidth))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  let pendingConfirm = $state<ToolConfirmRequestPayload | null>(null)
  let autoApproveTools = $state(false)

  function mapMessagesToDisplay(records: MessageDto[]): DisplayMessage[] {
    const result: DisplayMessage[] = []
    const toolSegmentsById = new Map<string, DisplaySegment>()

    for (const m of records) {
      const isPureToolResult =
        m.content.length > 0 && m.content.every((b) => b.type === 'tool_result')
      if (isPureToolResult) {
        for (const b of m.content) {
          if (b.type !== 'tool_result') continue
          const seg = toolSegmentsById.get(b.toolUseId)
          if (seg?.toolCall) {
            seg.toolCall.result = b.content
            seg.toolCall.isError = b.isError
          }
        }
        continue
      }

      const segments: DisplaySegment[] = []
      for (const b of m.content) {
        if (b.type === 'text') {
          segments.push({ id: crypto.randomUUID(), kind: 'text', agentRole: b.agentRole, text: b.text })
        } else if (b.type === 'tool_use') {
          const seg: DisplaySegment = {
            id: crypto.randomUUID(),
            kind: 'tool',
            agentRole: b.agentRole,
            toolCall: { id: b.id, name: b.name, input: JSON.stringify(b.input) }
          }
          segments.push(seg)
          toolSegmentsById.set(b.id, seg)
        }
      }
      result.push({ id: m.id, role: m.role, segments })
    }
    return result
  }

  async function selectSession(id: string): Promise<void> {
    activeId = id
    const records = await window.sachiv.listMessages(id)
    messages = mapMessagesToDisplay(records)
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

  /** Appends to the trailing segment if it's the same kind+speaker, else starts a new one — keeps consecutive same-speaker text as one flowing block. */
  function appendTextSegment(msg: DisplayMessage, text: string, agentRole?: AgentRole): void {
    const last = msg.segments[msg.segments.length - 1]
    if (last && last.kind === 'text' && last.agentRole === agentRole) {
      last.text = (last.text ?? '') + text
    } else {
      msg.segments.push({ id: crypto.randomUUID(), kind: 'text', agentRole, text })
    }
  }

  async function sendMessage(text: string, forcedRole?: AgentRole | null): Promise<void> {
    if (sending) return
    if (!hasKey) {
      showSettings = true
      return
    }
    sending = true

    const userMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      segments: [{ id: crypto.randomUUID(), kind: 'text', text }]
    }
    const assistantMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      segments: [],
      pending: true
    }
    messages.push(userMsg, assistantMsg)
    // messages is $state, and push() deep-proxies the pushed objects — mutate the
    // in-place proxy via this index, not the pre-proxy `assistantMsg` reference,
    // or Svelte's reactive graph never sees the updates (verified live: without
    // this, the pending spinner freezes forever even though the stream completes).
    const assistantIdx = messages.length - 1

    const { streamId } = await window.sachiv.sendChatMessage(activeId, text, forcedRole)

    const unsubscribe = window.sachiv.onChatStreamEvent((payload) => {
      if (payload.streamId !== streamId) return
      const event = payload.event
      const msg = messages[assistantIdx]
      if (event.type === 'text_delta') {
        appendTextSegment(msg, event.text, event.agentRole)
      } else if (event.type === 'tool_use_start') {
        msg.segments.push({
          id: crypto.randomUUID(),
          kind: 'tool',
          agentRole: event.agentRole,
          toolCall: { id: event.id, name: event.name, input: '' }
        })
      } else if (event.type === 'tool_use_delta') {
        const seg = msg.segments.find((s) => s.kind === 'tool' && s.toolCall?.id === event.id)
        if (seg?.toolCall) seg.toolCall.input += event.partialInput
      } else if (event.type === 'tool_result') {
        const seg = msg.segments.find((s) => s.kind === 'tool' && s.toolCall?.id === event.toolUseId)
        const call = seg?.toolCall
        if (call) {
          call.result = event.content
          call.isError = event.isError
        }
      } else if (event.type === 'error') {
        appendTextSegment(msg, `Error: ${event.message}`)
        msg.pending = false
        sending = false
        unsubscribe()
      } else if (event.type === 'message_stop') {
        // A tagged stop is a nested specialist's own round ending, not the whole
        // exchange — only an untagged (top-level) non-tool_use stop is truly final.
        if (event.stopReason === 'tool_use' || event.agentRole) return
        msg.pending = false
        sending = false
        unsubscribe()
      }
    })
  }

  function approveTool(input: Record<string, unknown>): void {
    if (!pendingConfirm) return
    window.sachiv.respondToolConfirm(pendingConfirm.toolUseId, true, input)
    pendingConfirm = null
  }

  function denyTool(): void {
    if (!pendingConfirm) return
    window.sachiv.respondToolConfirm(pendingConfirm.toolUseId, false)
    pendingConfirm = null
  }

  async function loadProviderState(id: string): Promise<void> {
    const descriptor = providers.find((p) => p.id === id)
    hasKey = descriptor?.requiresApiKey === false ? true : await window.sachiv.hasApiKey(id)
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
    providers = await window.sachiv.listProviders()
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

  window.sachiv.onToolConfirmRequest((payload) => {
    if (autoApproveTools) {
      window.sachiv.respondToolConfirm(payload.toolUseId, true, payload.input)
      return
    }
    pendingConfirm = payload
  })

  window.sachiv.getSetting('sidebarWidth').then((stored) => {
    if (stored) sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Number(stored)))
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
<main
  class:sidebar-collapsed={sidebarCollapsed}
  style={sidebarCollapsed ? undefined : `grid-template-columns: ${sidebarWidth}px 4px 1fr`}
>
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
  {#if !sidebarCollapsed}
    <div
      class="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onpointerdown={startSidebarResize}
    ></div>
  {/if}
  <section>
    <ChatView
      {messages}
      {statusLine}
      {sending}
      onSend={sendMessage}
      {providers}
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
    providerDisplayName={providers.find((p) => p.id === providerId)?.displayName ?? providerId}
    providerRequiresApiKey={providers.find((p) => p.id === providerId)?.requiresApiKey ?? true}
    {hasKey}
    onSave={saveApiKey}
    onClose={() => (showSettings = false)}
  />
{/if}

{#if pendingConfirm}
  <ToolConfirmDialog
    name={pendingConfirm.name}
    description={pendingConfirm.description}
    input={pendingConfirm.input}
    autoApprove={autoApproveTools}
    onApprove={approveTool}
    onDeny={denyTool}
    onToggleAutoApprove={(value) => (autoApproveTools = value)}
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
    grid-template-columns: 260px 4px 1fr;
    flex: 1;
    min-height: 0;
  }
  main.sidebar-collapsed {
    grid-template-columns: 0 1fr;
  }
  .sidebar-resize-handle {
    cursor: col-resize;
    background: transparent;
    position: relative;
  }
  .sidebar-resize-handle::after {
    content: '';
    position: absolute;
    inset: 0 1.5px;
    border-radius: 2px;
  }
  .sidebar-resize-handle:hover::after,
  .sidebar-resize-handle:active::after {
    background: var(--accent);
  }
  aside {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  main.sidebar-collapsed aside {
    border-right: none;
  }
  section {
    /* Grid items default to min-height: auto, so without this the chat area
       grows to fit every message instead of being clipped to the available
       space — the inner ChatView's overflow-y:auto never gets a chance to
       kick in and messages just get cut off with no way to scroll. */
    min-height: 0;
    overflow: hidden;
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
