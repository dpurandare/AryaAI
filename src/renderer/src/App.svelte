<script lang="ts">
  import SessionList from './lib/components/SessionList.svelte'
  import ChatView from './lib/components/ChatView.svelte'
  import SettingsPanel from './lib/components/SettingsPanel.svelte'
  import FirstRunSetup from './lib/components/FirstRunSetup.svelte'
  import {
    DEFAULT_SESSION_TITLE,
    type SessionDto,
    type MessageDto,
    type ToolConfirmRequestPayload,
    type LimitReachedRequestPayload,
    type ProviderDescriptor
  } from '@shared/ipc-contract'
  import type { AgentRole } from '@shared/agents'
  import type { RoleRosterEntryDto } from '@shared/ipc-contract'
  import { getThemeMode, setThemeMode, type ThemeMode } from './lib/theme'

  interface ToolCallDisplay {
    id: string
    name: string
    input: string
    result?: string
    isError?: boolean
    /** TASKS.md #82 — a `show_media` call's real payload, carried on the same tool segment rather than as a separate one; never sent to any provider (see protocol.ts's `image` ContentBlock doc comment), display-only. */
    image?: { path: string; mimeType: string; dataBase64: string }
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
    kind: 'text' | 'tool' | 'warning'
    agentRole?: AgentRole
    /** Holds the plain message for both 'text' and 'warning' kinds. */
    text?: string
    toolCall?: ToolCallDisplay
  }

  interface DisplayMessage {
    id: string
    role: 'user' | 'assistant'
    pending?: boolean
    /** Live-only "what's happening" hint from the backend's `status` stream
     * event (see orchestrator.ts's `roundStatusMessage`) — never persisted,
     * just shown by ChatView while `pending` and there's no active segment
     * of its own already reporting progress (a streaming text cursor, or a
     * tool call's own pending label). */
    statusText?: string
    /** Live-only checklist for a compound request's classify-and-plan pass
     * (see orchestrator.ts's `executePlan`) — never persisted; each step's
     * actual result already arrives as an ordinary segment via the same
     * delegation machinery normal delegation uses, so reloading a session
     * shows the full text even without this overlay. */
    plan?: { steps: { role: AgentRole; description: string }[]; stepStatus: ('pending' | 'running' | 'done' | 'error')[] }
    segments: DisplaySegment[]
  }

  /**
   * Everything about one session that changes while a turn runs, kept
   * per-session (not the single set of top-level variables this used to
   * be) so multiple sessions can generate at once: switching `activeId`
   * only changes which of these is *shown* — it never touches the others,
   * and a session's own event listener (set up in `sendMessage`) always
   * closes over its own runtime object, never the currently-active one.
   * Found live, before this existed: switching sessions mid-stream pointed
   * a stale array index at a message in the *new* session's freshly
   * reloaded array (or past its end), throwing on every subsequent event
   * for the abandoned stream, and the single global `sending`/
   * `currentStreamId` left whatever session you switched to looking
   * permanently "busy" until the invisible original stream finished.
   */
  interface SessionRuntime {
    messages: DisplayMessage[]
    sending: boolean
    currentStreamId: string
    sessionUsage: { inputTokens: number; outputTokens: number }
    pendingConfirm: ToolConfirmRequestPayload | null
    /** A round/time budget was hit and the orchestrator is waiting to hear whether to keep going — see orchestrator.ts's askToContinue. Mutually exclusive with pendingConfirm in practice (only one can be in flight at a time per stream), kept as its own field rather than folded into one union so ChatView's prop list stays a plain, obvious `X | null` for each. */
    pendingLimit: LimitReachedRequestPayload | null
    /** Whether `messages`/`sessionUsage` have been fetched from the DB at least once — after that, a session's own live event stream is the source of truth, not another DB read, or a background reply already written into `messages` would be clobbered by a stale reload the moment you switch back to it. */
    loaded: boolean
  }

  function emptyRuntime(): SessionRuntime {
    return {
      messages: [],
      sending: false,
      currentStreamId: '',
      sessionUsage: { inputTokens: 0, outputTokens: 0 },
      pendingConfirm: null,
      pendingLimit: null,
      loaded: false
    }
  }

  let statusLine = $state('Connecting...')
  let sessions = $state<SessionDto[]>([])
  let activeId = $state('')
  let runtimes = $state<Record<string, SessionRuntime>>({})
  let showSettings = $state(false)
  let showFirstRunSetup = $state(false)

  // Built-in and user-defined roles (design-discussion.md section 11): the Agent: picker and role labels read this. Re-read when the window
  // regains focus (the user may have edited a role file in another editor) and when Settings closes.
  let roleRoster = $state<RoleRosterEntryDto[]>([])
  async function loadRoleRoster(): Promise<void> {
    try {
      roleRoster = (await window.sachiv.getRoles()).roles
    } catch {
      // The picker and labels fall back to the built-ins.
    }
  }
  loadRoleRoster()
  window.addEventListener('focus', () => void loadRoleRoster())
  let firstRunStep = $state<'secrets' | 'python'>('secrets')
  let firstRunEnvPath = $state('')
  let providers = $state<ProviderDescriptor[]>([])
  let providerId = $state('openai')
  let hasKey = $state(false)
  let currentModel = $state('')
  /** The real context window for the currently selected provider/model — model-scoped, not per-session, so it lives here rather than in SessionRuntime. Refreshed whenever the model loads/changes (loadProviderState/changeModel below) and, as a fresher confirmation, by the context_window stream event mid-turn. Null until the first successful refresh (e.g. before any provider/model is configured), in which case ContextMeter falls back to its own static guess. */
  let contextWindow = $state<{ tokens: number; isEstimate: boolean } | null>(null)
  let sidebarCollapsed = $state(false)
  let sidebarWidth = $state(260)
  let isMac = $state(false)
  let userName = $state('')
  let updateAvailable = $state<{ version: string; releaseUrl: string } | null>(null)
  // initTheme() already resolved (main.ts awaits it before mount), so this
  // reflects the real persisted/resolved mode from the very first render.
  let themeMode = $state<ThemeMode>(getThemeMode())

  function changeThemeMode(mode: ThemeMode): void {
    themeMode = mode
    setThemeMode(mode)
  }

  function ensureRuntime(id: string): SessionRuntime {
    if (!runtimes[id]) runtimes[id] = emptyRuntime()
    return runtimes[id]
  }

  /** What's shown right now — always the *active* session's own runtime, never a copy. */
  let activeRuntime = $derived(runtimes[activeId] ?? emptyRuntime())

  /** Drives the sidebar's per-session activity dot (SessionList.svelte) — the only visible hint that a session you're not looking at is doing something. */
  let sessionActivity = $derived.by(() => {
    const result: Record<string, 'generating' | 'needs-confirmation'> = {}
    for (const [id, runtime] of Object.entries(runtimes)) {
      if (runtime.pendingConfirm || runtime.pendingLimit) result[id] = 'needs-confirmation'
      else if (runtime.sending) result[id] = 'generating'
    }
    return result
  })

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
  let autoApproveTools = $state(false)
  // Persisted per-tool rules (TASKS.md #40) — additive to the session-only
  // blanket toggle above, not a replacement for it. A plain object, not
  // $state(new Set()) — see feedback_svelte5-runes-gotchas memory.
  let autoApproveRules = $state<Record<string, boolean>>({})
  // Gates the orchestrator's classify-and-plan pre-pass (main/agents/
  // orchestrator.ts's `classifyAndPlan`) — an extra round-trip per message,
  // default on, but worth an escape hatch given local models' documented
  // long per-round "thinking" phase. Mirrors this app's default-on-missing
  // settings convention (see main/ipc/register.ts's own read of this key).
  let planningEnabled = $state(true)
  /** Global, not per-tool-call — matches Claude Code's own Cmd/Ctrl+O convention this was explicitly modeled on: one toggle for "how much tool detail is on screen," not a per-block expand state. Defaults to collapsed (false) — reported directly: full tool_result dumps in the transcript by default made the chat "look" broken/noisy even when the app was working correctly. */
  let toolDetailsExpanded = $state(false)

  function mapMessagesToDisplay(records: MessageDto[]): DisplayMessage[] {
    const result: DisplayMessage[] = []
    const toolSegmentsById = new Map<string, DisplaySegment>()

    for (const m of records) {
      // An `image` block (TASKS.md #82) rides alongside its `show_media`
      // call's own `tool_result` in the same synthetic message — still a
      // continuation of the round that produced it, not a new turn.
      const isPureToolResult =
        m.content.length > 0 && m.content.every((b) => b.type === 'tool_result' || b.type === 'image')
      if (isPureToolResult) {
        for (const b of m.content) {
          if (b.type !== 'tool_result' && b.type !== 'image') continue
          const seg = toolSegmentsById.get(b.toolUseId)
          if (!seg?.toolCall) continue
          if (b.type === 'tool_result') {
            seg.toolCall.result = b.content
            seg.toolCall.isError = b.isError
          } else {
            seg.toolCall.image = { path: b.path, mimeType: b.mimeType, dataBase64: b.dataBase64 }
          }
        }
        continue
      }

      const segments: DisplaySegment[] = []
      for (const b of m.content) {
        if (b.type === 'text') {
          segments.push({ id: crypto.randomUUID(), kind: 'text', agentRole: b.agentRole, text: b.text })
        } else if (b.type === 'warning') {
          segments.push({ id: crypto.randomUUID(), kind: 'warning', agentRole: b.agentRole, text: b.message })
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
    const runtime = ensureRuntime(id)
    // Once loaded, a session's own event listener (if it's generating) is
    // the source of truth for `messages`/`sessionUsage`, not another DB
    // read — this is exactly what lets switching back to a session show
    // whatever it produced while you were elsewhere, live-updated or
    // already finished, instead of re-fetching and losing that.
    if (runtime.loaded) return
    const records = await window.sachiv.listMessages(id)
    runtime.messages = mapMessagesToDisplay(records)
    runtime.sessionUsage = await window.sachiv.getSessionUsage(id)
    runtime.loaded = true
  }

  async function loadSessions(): Promise<void> {
    let list = await window.sachiv.listSessions()
    if (list.length === 0) {
      list = [await window.sachiv.createSession(DEFAULT_SESSION_TITLE)]
    }
    sessions = list
    await selectSession(list[0].id)
  }

  async function newSession(): Promise<void> {
    const created = await window.sachiv.createSession(DEFAULT_SESSION_TITLE)
    sessions = [created, ...sessions]
    await selectSession(created.id)
  }

  async function removeSession(id: string): Promise<void> {
    // Refuses a session that's actively generating too, not just the
    // active one — now that a background session can genuinely be
    // mid-turn, deleting it out from under `runChat` would violate the
    // FK constraint on its next insert (messages.session_id -> sessions.id
    // ON DELETE CASCADE) partway through, not just leave a dangling ref.
    if (id === activeId || runtimes[id]?.sending) return
    await window.sachiv.deleteSession(id)
    sessions = sessions.filter((s) => s.id !== id)
    delete runtimes[id]
  }

  async function exportSession(id: string): Promise<void> {
    // A cancelled save dialog is a normal, silent outcome — nothing to handle either way.
    await window.sachiv.exportSession(id)
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

  /**
   * `sessionId` is captured once, up front — the whole point is that this
   * keeps running correctly (writing into that session's own runtime, only
   * that session's own `sending`/`currentStreamId`) no matter what the
   * user does with `activeId` afterward, including sending a *second*
   * message in some other session before this one finishes.
   */
  async function sendMessage(text: string, forcedRole?: AgentRole | null): Promise<void> {
    const sessionId = activeId
    const runtime = ensureRuntime(sessionId)
    if (runtime.sending) return
    if (!hasKey) {
      showSettings = true
      return
    }
    runtime.sending = true

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
    runtime.messages.push(userMsg, assistantMsg)
    // runtime.messages is $state, and push() deep-proxies the pushed objects —
    // mutate the in-place proxy via this index, not the pre-proxy `assistantMsg`
    // reference, or Svelte's reactive graph never sees the updates (verified
    // live: without this, the pending spinner freezes forever even though the
    // stream completes).
    const assistantIdx = runtime.messages.length - 1

    const { streamId } = await window.sachiv.sendChatMessage(sessionId, text, forcedRole)
    runtime.currentStreamId = streamId

    const unsubscribe = window.sachiv.onChatStreamEvent((payload) => {
      if (payload.streamId !== streamId) return
      const event = payload.event
      const msg = runtime.messages[assistantIdx]
      if (event.type === 'status') {
        msg.statusText = event.message
      } else if (event.type === 'text_delta') {
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
      } else if (event.type === 'image') {
        const seg = msg.segments.find((s) => s.kind === 'tool' && s.toolCall?.id === event.toolUseId)
        if (seg?.toolCall) seg.toolCall.image = { path: event.path, mimeType: event.mimeType, dataBase64: event.dataBase64 }
      } else if (event.type === 'usage') {
        // Safe to sum: the orchestrator emits exactly one clean usage event
        // per round (see orchestrator.ts's roundUsage handling), not the raw
        // per-chunk events some providers repeat as a cumulative total.
        runtime.sessionUsage = {
          inputTokens: runtime.sessionUsage.inputTokens + event.inputTokens,
          outputTokens: runtime.sessionUsage.outputTokens + event.outputTokens
        }
      } else if (event.type === 'context_window') {
        contextWindow = { tokens: event.tokens, isEstimate: event.isEstimate }
      } else if (event.type === 'warning') {
        msg.segments.push({
          id: crypto.randomUUID(),
          kind: 'warning',
          agentRole: event.agentRole,
          text: event.message
        })
      } else if (event.type === 'plan') {
        msg.plan = { steps: event.steps, stepStatus: event.steps.map(() => 'pending') }
      } else if (event.type === 'plan_step_start') {
        if (msg.plan) msg.plan.stepStatus[event.index] = 'running'
      } else if (event.type === 'plan_step_done') {
        if (msg.plan) msg.plan.stepStatus[event.index] = event.isError ? 'error' : 'done'
      } else if (event.type === 'error') {
        appendTextSegment(msg, `Error: ${event.message}`)
        msg.pending = false
        runtime.sending = false
        unsubscribe()
      } else if (event.type === 'message_stop') {
        // A tagged stop is a nested specialist's own round ending, not the whole
        // exchange — only an untagged (top-level) non-tool_use stop is truly final.
        if (event.stopReason === 'tool_use' || event.agentRole) return
        if (event.stopReason === 'aborted') appendTextSegment(msg, '\n\n⏹ Stopped.')
        msg.pending = false
        runtime.sending = false
        unsubscribe()
      }
    })
  }

  /** Always scoped to whichever session is currently shown — never an invisible background one, since each session now has its own `currentStreamId`. */
  function stopGeneration(): void {
    const runtime = runtimes[activeId]
    if (!runtime) return
    if (runtime.currentStreamId) window.sachiv.cancelChat(runtime.currentStreamId)
    // The backend now treats an abort while awaiting confirmation (or a
    // pending continue-or-stop question) as a denial/stop (orchestrator.ts's
    // confirmOrAbort/askToContinue), but that resolution still has to travel
    // back over IPC — clear both immediately here so Stop feels instant
    // instead of leaving the composer replaced until that round-trips.
    runtime.pendingConfirm = null
    runtime.pendingLimit = null
  }

  function approveTool(input: Record<string, unknown>): void {
    const confirm = activeRuntime.pendingConfirm
    if (!confirm) return
    window.sachiv.respondToolConfirm(confirm.toolUseId, true, input)
    activeRuntime.pendingConfirm = null
  }

  function denyTool(): void {
    const confirm = activeRuntime.pendingConfirm
    if (!confirm) return
    window.sachiv.respondToolConfirm(confirm.toolUseId, false)
    activeRuntime.pendingConfirm = null
  }

  function respondLimit(continueWorking: boolean): void {
    const limit = activeRuntime.pendingLimit
    if (!limit) return
    window.sachiv.respondLimitReached(limit.requestId, continueWorking)
    activeRuntime.pendingLimit = null
  }

  function toggleAutoApproveTool(name: string, value: boolean): void {
    autoApproveRules = { ...autoApproveRules, [name]: value }
    window.sachiv.setSetting('autoApproveToolRules', JSON.stringify(autoApproveRules))
  }

  function changePlanningEnabled(value: boolean): void {
    planningEnabled = value
    window.sachiv.setSetting('planningEnabled', String(value))
  }

  function toggleToolDetails(): void {
    toolDetailsExpanded = !toolDetailsExpanded
    window.sachiv.setSetting('toolDetailsExpanded', String(toolDetailsExpanded))
  }

  /** Cmd+O on macOS, Ctrl+O elsewhere — same cross-platform split already used for the mode-picker's Ctrl+Tab (see ChatView.svelte), and the exact convention this feature was explicitly modeled on (Claude Code's own tool-output toggle). Global (window-level), not scoped to the composer, so it works regardless of what has focus — matching how a real app-wide view toggle should behave. */
  function onWindowKeydown(e: KeyboardEvent): void {
    const modifierHeld = isMac ? e.metaKey : e.ctrlKey
    if (modifierHeld && e.key.toLowerCase() === 'o') {
      e.preventDefault()
      toggleToolDetails()
    }
  }

  /** Best-effort — a fresh install with nothing configured yet just leaves contextWindow null, which ContextMeter already treats as "use my own static guess." */
  async function refreshContextWindow(): Promise<void> {
    contextWindow = await window.sachiv.getContextWindow()
  }

  async function loadProviderState(id: string): Promise<void> {
    const descriptor = providers.find((p) => p.id === id)
    hasKey = descriptor?.requiresApiKey === false ? true : await window.sachiv.hasApiKey(id)
    currentModel = (await window.sachiv.getSetting(`model:${id}`)) ?? ''
    await refreshContextWindow()
  }

  async function changeProvider(id: string): Promise<void> {
    providerId = id
    await window.sachiv.setSetting('activeProviderId', id)
    await loadProviderState(id)
  }

  async function changeModel(model: string): Promise<void> {
    await window.sachiv.setSetting(`model:${providerId}`, model)
    currentModel = model
    await refreshContextWindow()
  }

  async function saveApiKey(apiKey: string, keepOpen = false): Promise<void> {
    await window.sachiv.setApiKey(providerId, apiKey)
    await loadProviderState(providerId)
    if (!keepOpen) showSettings = false
  }

  // --- Leaving Settings (session click, New chat, the account row, Back) ---
  // Settings is a full-pane view, not a dialog, so picking a session from the sidebar has to close it. If something typed into Settings has
  // not been saved (an API key, an "add …" form — see SettingsPanel's pendingChanges), ask first instead of silently dropping it.
  type LeaveTarget = { kind: 'chat' } | { kind: 'new' } | { kind: 'session'; id: string }
  let settingsPanel = $state<{ getPendingLabels(): string[] } | undefined>()
  let leaveRequest = $state<LeaveTarget | null>(null)

  async function completeLeave(target: LeaveTarget): Promise<void> {
    leaveRequest = null
    showSettings = false
    void loadRoleRoster()
    if (target.kind === 'session') await selectSession(target.id)
    else if (target.kind === 'new') await newSession()
  }

  async function requestLeave(target: LeaveTarget): Promise<void> {
    if (settingsPanel && settingsPanel.getPendingLabels().length > 0) {
      leaveRequest = target
      return
    }
    await completeLeave(target)
  }

  function onSidebarSelect(id: string): Promise<void> {
    return showSettings ? requestLeave({ kind: 'session', id }) : selectSession(id)
  }

  function onSidebarNew(): Promise<void> {
    return showSettings ? requestLeave({ kind: 'new' }) : newSession()
  }

  function toggleSettings(): void {
    if (showSettings) void requestLeave({ kind: 'chat' })
    else showSettings = true
  }

  async function initProvider(): Promise<void> {
    providers = await window.sachiv.listProviders()
    providerId = (await window.sachiv.getSetting('activeProviderId')) ?? 'openai'
    await loadProviderState(providerId)
  }

  const ONBOARDING_SETTING_KEY = 'onboardingCompleted'

  /**
   * #75's first-run entry point for the secret-storage choice. Must never
   * fire for an existing real install that predates this setting — only
   * treats it as a genuine first run when there's truly nothing yet (no
   * sessions, no provider key configured for anything), backfilling the
   * flag silently otherwise so this check is cheap on every later launch.
   */
  async function checkFirstRun(): Promise<void> {
    if ((await window.sachiv.getSetting(ONBOARDING_SETTING_KEY)) === 'true') return
    const [existingSessions, allProviders] = await Promise.all([
      window.sachiv.listSessions(),
      window.sachiv.listProviders()
    ])
    const anyKeyConfigured = (await Promise.all(allProviders.map((p) => window.sachiv.hasApiKey(p.id)))).some(Boolean)
    if (existingSessions.length === 0 && !anyKeyConfigured) {
      firstRunEnvPath = (await window.sachiv.getSecretStorageInfo()).envFilePath
      firstRunStep = (await window.sachiv.getSetting(ONBOARDING_SECRETS_KEY)) === 'true' ? 'python' : 'secrets'
      showFirstRunSetup = true
    } else {
      await window.sachiv.setSetting(ONBOARDING_SETTING_KEY, 'true')
    }
  }

  /** Set once the secret-storage choice is made, so quitting during the Python step doesn't ask (or, for "file", re-switch) again. */
  const ONBOARDING_SECRETS_KEY = 'onboardingSecretsChosen'

  async function secretsChosen(): Promise<void> {
    await window.sachiv.setSetting(ONBOARDING_SECRETS_KEY, 'true')
  }

  async function finishOnboarding(): Promise<void> {
    await window.sachiv.setSetting(ONBOARDING_SETTING_KEY, 'true')
    showFirstRunSetup = false
  }

  async function chooseFileStorageOnFirstRun(): Promise<void> {
    await window.sachiv.switchSecretStorageToFile()
    await secretsChosen()
  }

  window.sachiv
    .getAppInfo()
    .then((info) => {
      statusLine = `Sachivji v${info.version}`
      document.title = statusLine
      isMac = info.platform === 'darwin'
      userName = info.userName
    })
    .catch((err: unknown) => {
      statusLine = `IPC error: ${String(err)}`
    })

  window.sachiv.onUpdateAvailable((payload) => {
    updateAvailable = payload
  })

  window.sachiv.onSessionTitleUpdated((payload) => {
    const session = sessions.find((s) => s.id === payload.sessionId)
    if (session) session.title = payload.title
  })

  window.sachiv.onToolConfirmRequest((payload) => {
    if (autoApproveTools || autoApproveRules[payload.name]) {
      window.sachiv.respondToolConfirm(payload.toolUseId, true, payload.input)
      return
    }
    // Routed to that session's own runtime, not a single global slot — a
    // confirmation from a session you're not currently looking at waits
    // there quietly (surfaced only via the sidebar's activity dot) instead
    // of popping a dialog over whatever you're actually doing.
    ensureRuntime(payload.sessionId).pendingConfirm = payload
  })

  window.sachiv.onLimitReachedRequest((payload) => {
    // No auto-approve equivalent — unlike a tool call, there's no per-name
    // rule that makes sense here, and silently auto-continuing would be
    // exactly the "just keeps going with no way to say stop" behavior this
    // whole feature exists to avoid.
    ensureRuntime(payload.sessionId).pendingLimit = payload
  })

  window.sachiv.getSetting('sidebarWidth').then((stored) => {
    if (stored) sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Number(stored)))
  })

  window.sachiv.getSetting('autoApproveToolRules').then((stored) => {
    if (stored) {
      try {
        autoApproveRules = JSON.parse(stored) as Record<string, boolean>
      } catch {
        // Malformed stored value — ignore and keep the empty default.
      }
    }
  })

  window.sachiv.getSetting('planningEnabled').then((stored) => {
    if (stored !== null && stored !== undefined) planningEnabled = stored !== 'false'
  })

  window.sachiv.getSetting('toolDetailsExpanded').then((stored) => {
    if (stored !== null && stored !== undefined) toolDetailsExpanded = stored === 'true'
  })

  // checkFirstRun's "is this genuinely a fresh install" check reads the
  // session list — it must run and finish *before* loadSessions gets a
  // chance to auto-create a default session (loadSessions does this
  // whenever the list is empty), or the two race: found live, the
  // first-run screen silently never appeared because loadSessions' own
  // session sometimes landed first, making the fresh-check see a
  // "pre-existing" session that was actually just its own side effect.
  checkFirstRun().then(() => {
    initProvider()
    loadSessions()
  })
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if showFirstRunSetup}
  <FirstRunSetup
    envFilePath={firstRunEnvPath}
    initialStep={firstRunStep}
    onChooseKeychain={secretsChosen}
    onChooseFile={chooseFileStorageOnFirstRun}
    onFinish={finishOnboarding}
  />
{/if}

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
{#if updateAvailable}
  <div class="update-banner">
    <span>A new version (v{updateAvailable.version}) is available.</span>
    <a href={updateAvailable.releaseUrl} target="_blank" rel="noopener noreferrer">View release</a>
    <button class="dismiss" onclick={() => (updateAvailable = null)} aria-label="Dismiss">×</button>
  </div>
{/if}
<main
  class:sidebar-collapsed={sidebarCollapsed}
  style={sidebarCollapsed ? undefined : `grid-template-columns: ${sidebarWidth}px 4px 1fr`}
>
  <aside>
    <SessionList
      {sessions}
      {activeId}
      activity={sessionActivity}
      onSelect={onSidebarSelect}
      onNew={onSidebarNew}
      onDelete={removeSession}
      onExport={exportSession}
    />
    <button class="user-row" aria-expanded={showSettings} title={showSettings ? 'Close settings' : 'Open settings'} onclick={toggleSettings}>
      <span class="avatar">{(userName || '?').charAt(0).toUpperCase()}</span>
      <span class="user-name">{userName || 'Account'}</span>
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
    {#if showSettings}
      <SettingsPanel
        bind:this={settingsPanel}
        leaveRequested={leaveRequest !== null}
        onBack={() => void requestLeave({ kind: 'chat' })}
        onLeaveResolved={(leave) => {
          const target = leaveRequest
          if (leave && target) void completeLeave(target)
          else leaveRequest = null
        }}
        providerDisplayName={providers.find((p) => p.id === providerId)?.displayName ?? providerId}
        providerRequiresApiKey={providers.find((p) => p.id === providerId)?.requiresApiKey ?? true}
        {hasKey}
        {autoApproveRules}
        {providers}
        {themeMode}
        {planningEnabled}
        onSave={saveApiKey}
        onClose={() => {
          showSettings = false
          void loadRoleRoster()
        }}
        onToggleAutoApproveRule={toggleAutoApproveTool}
        onChangeTheme={changeThemeMode}
        onChangePlanningEnabled={changePlanningEnabled}
      />
    {:else}
      <ChatView
        {roleRoster}
        messages={activeRuntime.messages}
        {statusLine}
        sending={activeRuntime.sending}
        onSend={sendMessage}
        onStop={stopGeneration}
        {providers}
        {providerId}
        model={currentModel}
        {hasKey}
        onChangeProvider={changeProvider}
        onChangeModel={changeModel}
        onNeedKey={() => (showSettings = true)}
        sessionUsage={activeRuntime.sessionUsage}
        {contextWindow}
        {toolDetailsExpanded}
        onToggleToolDetails={toggleToolDetails}
        {isMac}
        pendingConfirm={activeRuntime.pendingConfirm}
        {autoApproveTools}
        {autoApproveRules}
        onApproveTool={approveTool}
        onDenyTool={denyTool}
        onValidateTool={(name, input) => window.sachiv.validateToolInput(name, input)}
        onToggleAutoApprove={(value) => (autoApproveTools = value)}
        onToggleAutoApproveRule={toggleAutoApproveTool}
        pendingLimit={activeRuntime.pendingLimit}
        onRespondLimit={respondLimit}
      />
    {/if}
  </section>
</main>

<style>
  /* Base palette + font/color resets live in theme.css, shared with
     print-main.ts — this component only owns its own app-shell layout. */
  :global(body) {
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
  .update-banner {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.9rem;
    background: var(--accent);
    color: #fff;
    font-size: 0.82rem;
  }
  .update-banner a {
    color: #fff;
    text-decoration: underline;
    font-weight: 600;
  }
  .update-banner .dismiss {
    margin-left: auto;
    border: none;
    background: none;
    color: #fff;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0.8;
  }
  .update-banner .dismiss:hover {
    opacity: 1;
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
    flex-shrink: 0;    transition: transform 0.15s;
  }
  .user-row[aria-expanded='true'] .chevron {
    transform: rotate(180deg);
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
