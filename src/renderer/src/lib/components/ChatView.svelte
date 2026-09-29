<script lang="ts">
  import { tick } from 'svelte'
  import ModelPicker from './ModelPicker.svelte'
  import ContextMeter from './ContextMeter.svelte'
  import MarkdownText from './MarkdownText.svelte'
  import ToolConfirmDialog from './ToolConfirmDialog.svelte'
  import { AGENT_ROLES, roleLabel, type AgentRole } from '@shared/agents'
  import type { RoleRosterEntryDto } from '@shared/ipc-contract'
  import { parseSearchHistoryResult } from '../search-history-result'
import { formatToolInputForDisplay } from '../tool-input-display'
  import type { ToolConfirmRequestPayload, LimitReachedRequestPayload } from '@shared/ipc-contract'

  interface ToolCallDisplay {
    id: string
    name: string
    input: string
    result?: string
    isError?: boolean
    /** TASKS.md #82 — a `show_media` call's real payload, carried on the same tool segment rather than as a separate one; never sent to any provider, display-only. */
    image?: { path: string; mimeType: string; dataBase64: string }
  }

  interface DisplaySegment {
    id: string
    kind: 'text' | 'tool' | 'warning' | 'user_note'
    agentRole?: AgentRole
    /** Holds the plain message for 'text', 'warning' and 'user_note' kinds. */
    text?: string
    toolCall?: ToolCallDisplay
  }

  interface DisplayMessage {
    id: string
    role: 'user' | 'assistant'
    pending?: boolean
    statusText?: string
    plan?: { steps: { role: AgentRole; description: string }[]; stepStatus: ('pending' | 'running' | 'done' | 'error')[] }
    segments: DisplaySegment[]
  }

  interface Provider {
    id: string
    displayName: string
  }

  let {
    messages = [],
    statusLine = '',
    sending = false,
    onSend,
    onStop,
    providers,
    providerId,
    model,
    hasKey,
    onChangeProvider,
    onChangeModel,
    onNeedKey,
    sessionUsage,
    contextWindow,
    toolDetailsExpanded,
    onToggleToolDetails,
    isMac,
    pendingConfirm,
    autoApproveTools,
    autoApproveRules,
    onApproveTool,
    onDenyTool,
    onValidateTool,
    onToggleAutoApprove,
    onToggleAutoApproveRule,
    pendingLimit,
    onRespondLimit,
    roleRoster = [],
    onSteer
  }: {
    messages: DisplayMessage[]
    statusLine: string
    sending: boolean
    /** Built-in and user-defined roles (the picker, and labels for user-defined ones). Empty until the first load: the built-ins are used. */
    roleRoster?: readonly RoleRosterEntryDto[]
    onSend: (text: string, forcedRole?: AgentRole | null) => void
    onStop: () => void
    providers: readonly Provider[]
    providerId: string
    model: string
    hasKey: boolean
    onChangeProvider: (id: string) => void
    onChangeModel: (model: string) => void
    onNeedKey: () => void
    sessionUsage: { inputTokens: number; outputTokens: number }
    contextWindow: { tokens: number; isEstimate: boolean } | null
    /** Global "show full tool output" toggle (Cmd/Ctrl+O, owned by App.svelte so the hotkey works regardless of what has focus) — see the .tool-call rendering below. */
    toolDetailsExpanded: boolean
    onToggleToolDetails: () => void
    /** For the tool-output toggle's tooltip label only — the real Cmd/Ctrl+O handling lives in App.svelte. */
    isMac: boolean
    /**
     * When set, this session has a tool call awaiting approval — the
     * composer below renders the inline confirmation UI in place of the
     * normal input for as long as this stays non-null, rather than a modal
     * overlay elsewhere on screen. See ToolConfirmDialog.svelte's own doc
     * comment for why: a separately-rendered overlay could go invisible
     * with no way back to a usable composer short of restarting the app;
     * this is the one screen area already guaranteed visible whenever this
     * session is on screen at all.
     */
    pendingConfirm: ToolConfirmRequestPayload | null
    autoApproveTools: boolean
    autoApproveRules: Record<string, boolean>
    onApproveTool: (input: Record<string, unknown>) => void
    onDenyTool: () => void
    onValidateTool: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
    onToggleAutoApprove: (value: boolean) => void
    onToggleAutoApproveRule: (name: string, value: boolean) => void
    /** Same idea as pendingConfirm, for a different question — a round/time budget ran out and the orchestrator is waiting to hear whether to keep going (see orchestrator.ts's askToContinue) rather than silently wrapping up. Mutually exclusive with pendingConfirm in the composer-area render below. */
    pendingLimit: LimitReachedRequestPayload | null
    onRespondLimit: (continueWorking: boolean) => void
    /** TASKS.md #158: drop a correcting comment in while the orchestrator is actively working, without
     * waiting for the whole turn or hitting Stop — a softer, non-destructive alternative to Stop. */
    onSteer: (text: string) => void
  } = $props()

  let draft = $state('')
  /** TASKS.md #158: separate from `draft` so an in-progress note doesn't clobber (or get clobbered by) the
   * next real message's own draft, which the composer reverts to showing the moment `sending` goes false. */
  let steerDraft = $state('')

  function steer(): void {
    const text = steerDraft.trim()
    if (!text) return
    steerDraft = ''
    onSteer(text)
  }

  // Drag-to-resize the composer, matching the sidebar's own resize-handle
  // pattern (App.svelte's startSidebarResize) instead of the textarea's
  // native browser corner-drag — one consistent resize interaction across
  // the app rather than two different ones.
  const COMPOSER_MIN_HEIGHT = 40
  const COMPOSER_MAX_HEIGHT = 480
  let composerHeight = $state(COMPOSER_MIN_HEIGHT)
  window.sachiv.getSetting('composerHeight').then((stored) => {
    if (stored) composerHeight = Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, Number(stored)))
  })

  function startComposerResize(event: PointerEvent): void {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = composerHeight

    function onMove(moveEvent: PointerEvent): void {
      // The handle sits above the composer — dragging up (clientY decreasing) grows it.
      const next = startHeight + (startY - moveEvent.clientY)
      composerHeight = Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, next))
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.sachiv.setSetting('composerHeight', String(composerHeight))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Plain $state object, not $state(new Set()) — a raw Set's own add/delete
  // methods aren't deep-reactive under Svelte 5 runes (that needs SvelteSet
  // from svelte/reactivity); property writes on a plain object are, and
  // that's already the pattern used elsewhere in this app (verified live:
  // a Set here silently never triggered a re-render on click).
  let expandedIds = $state<Record<string, boolean>>({})
  /**
   * TASKS.md #88 — separate from `expandedIds` above (that one caps a
   * single block's own *content* preview; this one is a per-tool-call
   * override of the whole block's collapsed/expanded state, layered on top
   * of #72's global `toolDetailsExpanded` toggle). `undefined` = no
   * explicit choice yet, so the default below applies; `true`/`false` once
   * the user has clicked that specific entry's head line.
   */
  let toolBlockOverride = $state<Record<string, boolean>>({})

  const PREVIEW_MAX_CHARS = 500
  const PREVIEW_MAX_LINES = 10

  // The `.messages` div never scrolled itself — new content (a sent
  // message, a streamed reply) just extended past the bottom of the
  // scrollport with no code anywhere driving scrollTop, so anything past
  // the first screenful required a manual scroll to see. `stickToBottom`
  // is true by default (and whenever the user is already near the
  // bottom or just sent something) so streaming naturally follows the
  // newest content; it goes false only once the user deliberately
  // scrolls up to read earlier history, so we don't yank them back down
  // mid-read.
  let messagesEl: HTMLDivElement | undefined = $state()
  let stickToBottom = $state(true)
  const BOTTOM_THRESHOLD_PX = 48

  function onMessagesScroll(): void {
    if (!messagesEl) return
    const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
    stickToBottom = distanceFromBottom < BOTTOM_THRESHOLD_PX
  }

  $effect(() => {
    // Deep-read every mutable field so this reruns on each streamed token
    // (text_delta appends, tool_use_delta/tool_result updates in place),
    // not just when a whole new message/segment object is pushed.
    for (const m of messages) {
      for (const s of m.segments) {
        void s.text
        void s.toolCall?.input
        void s.toolCall?.result
      }
    }
    if (!stickToBottom) return
    tick().then(() => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
    })
  })

  /** `null` = Auto (orchestrator decides). Sticky across sends until cycled again. */
  let forcedRole: AgentRole | null = $state(null)
  // The picker cycles Auto plus every pickable, enabled role — built-in or user-defined — from the roster.
  const modeCycle = $derived<(AgentRole | null)[]>([
    null,
    ...(roleRoster.length ? roleRoster.filter((r) => r.pickable && r.enabled).map((r) => r.id) : AGENT_ROLES)
  ])

  /** A role's label: the roster's (covers user-defined roles), else the built-in / humanized one. */
  function label(role: AgentRole): string {
    return roleRoster.find((r) => r.id === role)?.label ?? roleLabel(role)
  }

  function cycleMode(direction: 1 | -1): void {
    const idx = modeCycle.indexOf(forcedRole)
    forcedRole = modeCycle[(idx + direction + modeCycle.length) % modeCycle.length]
  }

  function modeLabel(role: AgentRole | null): string {
    return role ? label(role) : 'Auto'
  }

  function limitReachedMessage(limit: LimitReachedRequestPayload): string {
    const who = limit.agentRole ? `The ${label(limit.agentRole)} specialist` : 'This turn'
    return limit.reason === 'time'
      ? `${who} has been working for a while without finishing. Give it more time, or stop here?`
      : `${who} has used all ${limit.maxRounds} steps available without finishing. Allow more steps, or stop here?`
  }

  function submit(): void {
    const text = draft.trim()
    if (!text || sending) return
    draft = ''
    stickToBottom = true
    onSend(text, forcedRole)
  }

  function toggleExpand(id: string): void {
    expandedIds[id] = !expandedIds[id]
  }

  // Long pasted/typed user input renders as one huge bubble otherwise —
  // collapse it to a short preview with a click-to-expand toggle. Display
  // only: the full text is still what gets sent to the model and stored.
  // Reused for a tool call's own result body too (TASKS.md #87) — same
  // "noisy giant blob vs. a capped preview with its own expand toggle"
  // shape, just a different content source.
  function previewOf(text: string): { text: string; truncated: boolean } {
    const lines = text.split('\n')
    let preview = lines.length > PREVIEW_MAX_LINES ? lines.slice(0, PREVIEW_MAX_LINES).join('\n') : text
    if (preview.length > PREVIEW_MAX_CHARS) preview = preview.slice(0, PREVIEW_MAX_CHARS)
    return { text: preview, truncated: preview.length < text.length }
  }

  /**
   * TASKS.md #88 — the id of the most recent real (non-delegate) tool-call
   * segment across the *whole* transcript, not just one message bubble.
   * Recomputed reactively as new tool calls stream in, so the previous
   * "most recent" one automatically stops being expanded-by-default the
   * instant a newer one appears — no manual bookkeeping needed to "hand
   * off" the default.
   */
  let lastToolSegmentId = $derived.by((): string | undefined => {
    let last: string | undefined
    for (const m of messages) {
      for (const s of m.segments) {
        if (s.kind === 'tool' && s.toolCall && !s.toolCall.name.startsWith('delegate_to_')) last = s.id
      }
    }
    return last
  })

  /** Whether a given tool-call segment's body should currently render in full — see `toolBlockOverride`'s own doc comment for the default-vs-override split. */
  function isToolBlockExpanded(segmentId: string): boolean {
    return toolDetailsExpanded && (toolBlockOverride[segmentId] ?? segmentId === lastToolSegmentId)
  }

  function toggleToolBlock(segmentId: string): void {
    if (!toolDetailsExpanded) return
    toolBlockOverride[segmentId] = !isToolBlockExpanded(segmentId)
  }
</script>

<div class="chat-view">
  <div class="messages" bind:this={messagesEl} onscroll={onMessagesScroll}>
    {#if messages.length === 0}
      <p class="placeholder">Say hello to get started.</p>
    {/if}
    {#each messages as message (message.id)}
      <div class="bubble {message.role}">
        {#if message.plan}
          <div class="plan-checklist">
            {#each message.plan.steps as step, i (i)}
              {@const status = message.plan.stepStatus[i]}
              <div class="plan-step" class:done={status === 'done'} class:error={status === 'error'}>
                <span class="plan-step-icon"
                  >{status === 'done' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '⋯' : '○'}</span
                >
                <span class="plan-step-role">{label(step.role)}</span>
                <span class="plan-step-desc">{step.description}</span>
              </div>
            {/each}
          </div>
        {/if}
        {#each message.segments as segment, i (segment.id)}
          {@const prevRole = i > 0 ? message.segments[i - 1].agentRole : undefined}
          {#if segment.agentRole && segment.agentRole !== prevRole}
            <div class="agent-chip">{label(segment.agentRole)} agent</div>
          {/if}
          {#if segment.kind === 'tool' && segment.toolCall}
            {@const isDelegate = segment.toolCall.name.startsWith('delegate_to_')}
            {@const isResolved = segment.toolCall.result !== undefined}
            {@const showFull = isToolBlockExpanded(segment.id)}
            {@const blockClickable = toolDetailsExpanded && !isDelegate && isResolved}
            <div class="tool-call" class:collapsed={!showFull}>
              <svelte:element
                this={blockClickable ? 'button' : 'div'}
                class="tool-call-head"
                class:clickable={blockClickable}
                type={blockClickable ? 'button' : undefined}
                role={blockClickable ? 'button' : undefined}
                onclick={blockClickable ? () => toggleToolBlock(segment.id) : undefined}
              >
                <span class="tool-icon">⚙</span>
                <code>{segment.toolCall.name}</code>
                {#if !(showFull && !isDelegate)}
                  <span class="tool-input">{segment.toolCall.input}</span>
                {/if}
                {#if !showFull && !isDelegate && isResolved}
                  <!-- Collapsed + already resolved: a one-glyph result indicator
                       instead of the full body below — full detail is one
                       Cmd/Ctrl+O (or a click on this entry, TASKS.md #88) away,
                       not lost, just not filling the transcript by default.
                       Reported directly: full tool output shown for every call
                       by default made the chat look broken/noisy even when the
                       app was working correctly. -->
                  <span class="tool-status" class:error={segment.toolCall.isError} title={segment.toolCall.isError ? 'Error — click or Cmd/Ctrl+O for details' : 'Done — click or Cmd/Ctrl+O for details'}>
                    {segment.toolCall.isError ? '✗' : '✓'}
                  </span>
                {/if}
              </svelte:element>
              {#if showFull && !isDelegate && segment.toolCall.input}
                <!-- TASKS.md #109: an expanded block shows the whole command, wrapped (the collapsed head's single ellipsised line
                     hid most of a long command even after opening the block). Same capped-preview-plus-toggle as the result body
                     (#87), keyed separately so the two toggles never collide. -->
                {@const inputText = formatToolInputForDisplay(segment.toolCall.input)}
                {@const inputPreview = previewOf(inputText)}
                {@const inputExpanded = Boolean(expandedIds[segment.id + ':input'])}
                <div class="tool-input-full">{inputExpanded ? inputText : inputPreview.text}{#if inputPreview.truncated && !inputExpanded}…{/if}</div>
                {#if inputPreview.truncated}
                  <button class="expand-toggle" onclick={() => toggleExpand(segment.id + ':input')}>
                    {inputExpanded ? 'Show less' : 'Show more'}
                  </button>
                {/if}
              {/if}
              {#if segment.toolCall.image}
                <!-- TASKS.md #82 — always shown regardless of the block's own
                     collapsed/expanded state: showing the image *is* the
                     point of this tool, so it shouldn't hide behind the same
                     toggle built for noisy raw tool output. -->
                <img
                  class="tool-image"
                  src={`data:${segment.toolCall.image.mimeType};base64,${segment.toolCall.image.dataBase64}`}
                  alt={segment.toolCall.image.path}
                />
              {/if}
              {#if !isDelegate}
                {#if isResolved}
                  {#if showFull}
                    {@const historicalResults =
                      segment.toolCall.name === 'search_history' && !segment.toolCall.isError
                        ? parseSearchHistoryResult(segment.toolCall.result ?? '')
                        : null}
                    {#if historicalResults}
                      <div class="tool-result historical-results">
                        {#each historicalResults as hit, i (i)}
                          <div class="historical-result">
                            <div class="historical-result-meta">
                              {hit.session} · {hit.date} · relevance {hit.relevance}
                            </div>
                            <MarkdownText text={hit.text} />
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <!-- TASKS.md #87: even within an expanded block, an
                           individually large result (a long file read, a
                           verbose shell/git output) still rendered in full,
                           unbounded — a second, finer-grained noise problem
                           #72's whole-block collapse didn't address. Same
                           capped-preview-plus-expand pattern already used for
                           a long user message above, keyed by this segment's
                           own id so it never collides with that toggle. -->
                      {@const resultPreview = previewOf(segment.toolCall.result ?? '')}
                      {@const resultExpanded = Boolean(expandedIds[segment.id])}
                      <div class="tool-result" class:error={segment.toolCall.isError}>{resultExpanded
                          ? segment.toolCall.result
                          : resultPreview.text}{#if resultPreview.truncated && !resultExpanded}…{/if}</div>
                      {#if resultPreview.truncated}
                        <button class="expand-toggle" onclick={() => toggleExpand(segment.id)}>
                          {resultExpanded ? 'Show less' : 'Show more'}
                        </button>
                      {/if}
                    {/if}
                  {/if}
                {:else}
                  <div class="tool-result pending">Waiting for confirmation...</div>
                {/if}
              {:else if segment.toolCall.result === undefined}
                {@const delegateRole = segment.toolCall.name.slice('delegate_to_'.length).replaceAll('_', '-')}
                <!-- Delegate calls need no confirmation and no result box of their own —
                     the specialist's own attributed segments right below already show the
                     answer; showing it again here (the tool_result content the outer model
                     needs for its own context) would just duplicate it. Naming the actual
                     target role (not the raw "Working...") is the orchestrator's own routing
                     decision surfacing as a real, live status instead of another dead pause. -->
                <div class="tool-result pending">
                  Delegating to {label(delegateRole)} agent…
                </div>
              {/if}
            </div>
          {:else if segment.kind === 'text'}
            {#if message.role === 'user'}
              {@const preview = previewOf(segment.text ?? '')}
              {@const expanded = Boolean(expandedIds[segment.id])}
              <span class="text"
                >{expanded ? segment.text : preview.text}{#if preview.truncated && !expanded}…{/if}</span
              >
              {#if preview.truncated}
                <button class="expand-toggle" onclick={() => toggleExpand(segment.id)}>
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              {/if}
            {:else}
              <MarkdownText text={segment.text ?? ''} />
            {/if}
          {:else if segment.kind === 'warning'}
            <div class="warning-note">⚠️ {segment.text}</div>
          {:else if segment.kind === 'user_note'}
            <!-- TASKS.md #158: a mid-run steering comment — visually distinct from both the assistant's own
                 text and a warning, since it's the user's own words injected partway through. -->
            <div class="user-note">💬 <strong>Note added mid-run:</strong> {segment.text}</div>
          {/if}
        {/each}
        {#if message.pending}
          {@const last = message.segments[message.segments.length - 1]}
          {@const lastIsUnresolvedTool = last?.kind === 'tool' && last.toolCall?.result === undefined}
          {#if last?.kind === 'text'}
            <!-- Actively streaming text is its own live indicator. -->
            <span class="text cursor">▌</span>
          {:else if !lastIsUnresolvedTool}
            <!-- No segment yet, or the last one already finished (e.g. a
                 resolved tool result) and the next round hasn't produced
                 anything visible yet — show the backend's real per-round
                 status instead of a dead pause. An in-flight tool/delegate
                 call is skipped here since its own box already carries a
                 pending label ("Waiting for confirmation...", "Delegating
                 to X agent…") — this would just duplicate it. -->
            <span class="thinking">{message.statusText ?? 'Thinking…'}</span>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  <div
    class="composer-resize-handle"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize message input"
    onpointerdown={startComposerResize}
  ></div>

  <div class="composer-area">
    {#if pendingConfirm}
      <ToolConfirmDialog
        toolUseId={pendingConfirm.toolUseId}
        name={pendingConfirm.name}
        description={pendingConfirm.description}
        input={pendingConfirm.input}
        secretFields={pendingConfirm.secretFields ?? []}
        hasValidation={pendingConfirm.hasValidation ?? false}
        autoApprove={autoApproveTools}
        autoApproveTool={Boolean(autoApproveRules[pendingConfirm.name])}
        onApprove={onApproveTool}
        onDeny={onDenyTool}
        onTalkAboutIt={(comment) => {
          onSteer(comment)
          onDenyTool()
        }}
        {onStop}
        onValidate={(input) => onValidateTool(pendingConfirm.name, input)}
        onToggleAutoApprove={onToggleAutoApprove}
        onToggleAutoApproveTool={(value) => onToggleAutoApproveRule(pendingConfirm.name, value)}
      />
    {:else if pendingLimit}
      <div class="limit-reached" role="group" aria-label="Continue or stop">
        <p>{limitReachedMessage(pendingLimit)}</p>
        <div class="limit-actions">
          <button type="button" onclick={() => onRespondLimit(false)}>Stop here</button>
          <button type="button" class="primary" onclick={() => onRespondLimit(true)}>Continue</button>
        </div>
      </div>
    {:else if sending}
      <!-- TASKS.md #158: while a turn is running, the composer becomes a steering-note input instead of a
           frozen, disabled box — Enter sends a correcting comment (onSteer), not a new turn. Stop stays
           available alongside it, unchanged, for a hard abort. -->
      <form class="composer" onsubmit={(e) => (e.preventDefault(), steer())}>
        <textarea
          bind:value={steerDraft}
          style="height: {composerHeight}px"
          placeholder="Add a note while this is running (Enter to send) — Stop to cancel instead"
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              steer()
            }
          }}
        ></textarea>
        <button class="send steer" type="submit" disabled={!steerDraft.trim()} aria-label="Add note">💬</button>
        <button class="send stop" type="button" onclick={onStop} aria-label="Stop generating">⏹</button>
      </form>
    {:else}
      <form class="composer" onsubmit={(e) => (e.preventDefault(), submit())}>
        <textarea
          bind:value={draft}
          style="height: {composerHeight}px"
          placeholder="Message Sachivji..."
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Tab' && e.ctrlKey) {
              // Cmd+Tab is the OS app-switcher and can't be intercepted by any app,
              // hence Ctrl+Tab here — capturable within a focused field, and the
              // same convention browsers/editors already use for cycling tabs.
              e.preventDefault()
              cycleMode(e.shiftKey ? -1 : 1)
            }
          }}
        ></textarea>
        <button class="send" type="submit" disabled={!draft.trim()} aria-label="Send">↵</button>
      </form>
    {/if}

    <div class="status-bar">
      <div class="status-left">
        <span class="status-text">{statusLine}</span>
        <button
          class="mode-picker"
          class:pinned={forcedRole !== null}
          onclick={() => cycleMode(1)}
          title={forcedRole !== null
            ? `Pinned to ${modeLabel(forcedRole)} — this agent alone, no auto hand-off to others. Click or Ctrl+Tab to cycle, Ctrl+Shift+Tab to reverse.`
            : 'Ctrl+Tab to cycle agent, Ctrl+Shift+Tab to reverse'}
        >
          <span class="dot"></span>
          Agent: {modeLabel(forcedRole)}
        </button>
        {#if model}
          <ContextMeter
            {model}
            inputTokens={sessionUsage.inputTokens}
            outputTokens={sessionUsage.outputTokens}
            {contextWindow}
          />
        {/if}
      </div>
      <div class="status-right">
        <button
          class="tool-details-toggle"
          class:on={toolDetailsExpanded}
          type="button"
          onclick={onToggleToolDetails}
          title={`${toolDetailsExpanded ? 'Hide' : 'Show'} full tool output (${isMac ? 'Cmd' : 'Ctrl'}+O)`}
        >
          {toolDetailsExpanded ? 'Tool output: shown' : 'Tool output: hidden'}
        </button>
        <ModelPicker
          {providers}
          {providerId}
          {model}
          {hasKey}
          {onChangeProvider}
          {onChangeModel}
          {onNeedKey}
        />
      </div>
    </div>
  </div>
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
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .placeholder {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .bubble {
    padding: 0.55rem 0.8rem;
    border-radius: 12px;
    white-space: pre-wrap;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .bubble.user {
    align-self: flex-end;
    max-width: 70%;
    background: var(--user-bubble);
  }
  .bubble.assistant {
    align-self: flex-start;
    /* Wider than the user bubble — assistant replies (agent narration, tool
       summaries, longer answers) wrap far more than short user prompts do,
       so the same 70% cap left a lot of unused horizontal space. */
    max-width: 92%;
    background: var(--panel);
  }
  .agent-chip {
    display: inline-block;
    margin-bottom: 0.3rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--accent);
    font-size: 0.7rem;
    font-weight: 600;
  }
  .bubble.assistant :global(.markdown-body) {
    white-space: normal;
  }
  .cursor {
    color: var(--text-muted);
  }
  /* Shown only before the first segment of a reply arrives — otherwise the
     bubble is just an empty box with a lone blinking cursor in it, with no
     indication anything is happening (the default local model has a long
     silent "thinking" phase before its first token). Once real content
     (text or a tool call) starts, this is replaced by that content plus
     the normal trailing .cursor, not shown alongside it. */
  .thinking {
    display: inline-block;
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.9rem;
    animation: thinking-pulse 1.4s ease-in-out infinite;
  }
  @keyframes thinking-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }
  .expand-toggle {
    display: block;
    margin-top: 0.35rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
  }
  .expand-toggle:hover {
    text-decoration: underline;
  }
  .tool-call {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.65rem;
    margin-bottom: 0.4rem;
    font-size: 0.78rem;
  }
  .tool-call-head {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    color: var(--text-muted);
    /* Resets browser <button> chrome when rendered as one (TASKS.md #88,
       via <svelte:element> — a real <button> when this entry is clickable,
       a plain <div> otherwise) — harmless no-ops on the plain <div> case. */
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    text-align: left;
    width: 100%;
  }
  /* A resolved, non-delegate entry's head line becomes its own per-entry
     expand/collapse toggle once global detail mode (#72) is on, independent
     of the Cmd/Ctrl+O shortcut. */
  .tool-call-head.clickable {
    cursor: pointer;
    border-radius: 4px;
  }
  .tool-call-head.clickable:hover {
    color: var(--text);
  }
  .tool-call-head.clickable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tool-icon {
    color: var(--accent);
  }
  .tool-call-head code {
    color: var(--text);
    font-family: ui-monospace, monospace;
  }
  .tool-input {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
  }
  .tool-input-full {
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
    margin: 0.2rem 0 0.3rem;
  }
  .tool-result {
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    color: var(--text-muted);
  }
  .tool-image {
    display: block;
    max-width: 100%;
    max-height: 420px;
    border-radius: 6px;
    border: 1px solid var(--border);
    margin-top: 0.3rem;
    object-fit: contain;
  }
  .tool-result.pending {
    font-style: italic;
  }
  .tool-result.error {
    color: var(--warn);
  }
  .tool-call.collapsed {
    padding-bottom: 0.5rem;
  }
  .tool-status {
    margin-left: auto;
    font-family: ui-monospace, monospace;
    color: var(--text-muted);
  }
  .tool-status.error {
    color: var(--warn);
  }
  .warning-note {
    margin-bottom: 0.4rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--warn);
    border-radius: 8px;
    color: var(--warn);
    font-size: 0.82rem;
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  /* TASKS.md #158: same shape as .warning-note but in --accent, so a mid-run steering note reads as
     "the user said this," not as a problem the app is flagging. */
  .user-note {
    margin-bottom: 0.4rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--accent);
    border-radius: 8px;
    color: var(--accent);
    font-size: 0.82rem;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .plan-checklist {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.65rem;
    margin-bottom: 0.4rem;
    font-size: 0.78rem;
  }
  .plan-step {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    color: var(--text-muted);
  }
  .plan-step.done {
    color: var(--text);
  }
  .plan-step.error {
    color: var(--warn);
  }
  .plan-step-icon {
    color: var(--accent);
    width: 1em;
  }
  .plan-step-role {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--accent);
  }
  .plan-step-desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .historical-results {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .historical-result {
    padding-top: 0.4rem;
    border-top: 1px solid var(--border);
  }
  .historical-result:first-child {
    padding-top: 0;
    border-top: none;
  }
  .historical-result-meta {
    font-family: ui-monospace, monospace;
    color: var(--text-muted);
    font-size: 0.72rem;
    margin-bottom: 0.25rem;
  }
  /* search_history's excerpts are real markdown/KaTeX content, not raw
     tool output — override the monospace/pre-wrap/muted styling `.tool-result`
     sets above (this container also carries that class, for the shared card
     background/padding) back to normal prose. */
  .historical-result :global(.markdown-body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: var(--text);
    white-space: normal;
  }
  /* Mirrors App.svelte's .sidebar-resize-handle exactly — same thin-bar,
     hover/active-accent affordance, just row-resize instead of col-resize. */
  .composer-resize-handle {
    flex-shrink: 0;
    height: 6px;
    cursor: row-resize;
    background: transparent;
    position: relative;
  }
  .composer-resize-handle::after {
    content: '';
    position: absolute;
    inset: 1.5px 0;
    border-radius: 2px;
  }
  .composer-resize-handle:hover::after,
  .composer-resize-handle:active::after {
    background: var(--accent);
  }
  .composer-area {
    padding: 0.75rem 1.25rem 0.6rem;
    border-top: 1px solid var(--border);
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 0.6rem 0.6rem 0.6rem 1.1rem;
  }
  .limit-reached {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 0.7rem 1rem;
  }
  .limit-reached p {
    margin: 0;
    font-size: 0.85rem;
  }
  .limit-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .limit-actions button {
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-hover);
    color: var(--text);
    cursor: pointer;
  }
  .limit-actions button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
    font-weight: 600;
  }
  textarea {
    flex: 1;
    /* Height is driven by composerHeight (set via composer-resize-handle,
       same drag pattern as the sidebar's own handle) rather than the
       browser's native corner-drag — one consistent resize interaction
       across the app instead of two different ones. */
    resize: none;
    padding: 0.35rem 0;
    border: none;
    background: none;
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
  }
  textarea:focus {
    outline: none;
  }
  .send {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: #1a1a1a;
    cursor: pointer;
    font-size: 1rem;
    flex-shrink: 0;
  }
  .send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  /* TASKS.md #158: a lighter, outline treatment vs. .stop's solid fill — Stop (the more consequential,
     destructive action) should read as the primary control; Add-note is the secondary, softer one. */
  .send.steer {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
  }
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.25rem 0;
  }
  .status-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .status-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .tool-details-toggle {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
  }
  .tool-details-toggle:hover {
    background: var(--panel-hover);
    color: var(--text);
  }
  .tool-details-toggle.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .status-text {
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .mode-picker {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
  }
  .mode-picker:hover {
    background: var(--panel-hover);
    color: var(--text);
  }
  .mode-picker .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  /* Pinned away from "Auto" changes what the app can do (no delegation, no
     orchestrator) — worth standing out from the rest of the muted status
     bar rather than reading as just another status label. Found live: a
     session stayed pinned to one specialist across several unrelated
     follow-ups without the user noticing. */
  .mode-picker.pinned {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
</style>
