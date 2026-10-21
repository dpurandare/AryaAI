<script lang="ts">
  import { commandWarning, isShellLikeTool } from '@shared/command-risk'

  let {
    toolUseId,
    name,
    description,
    input,
    secretFields,
    hasValidation,
    autoApprove,
    autoApproveTool,
    onApprove,
    onDeny,
    onTalkAboutIt,
    onApproveWithComment,
    onStop,
    onValidate,
    onToggleAutoApprove,
    onToggleAutoApproveTool
  }: {
    /** Identifies which confirmation request this is — the reset trigger below keys off it rather than component-creation time, so a genuinely new request can never show stale JSON/secret fields from a previous one. */
    toolUseId: string
    name: string
    description: string
    input: Record<string, unknown>
    secretFields: string[]
    hasValidation: boolean
    autoApprove: boolean
    autoApproveTool: boolean
    onApprove: (input: Record<string, unknown>) => void
    /** Denies only this one tool call — the turn continues, and the model sees the denial and decides what to do next. */
    onDeny: () => void
    /**
     * TASKS.md #154: a third sibling to Deny and Edit-then-Approve, not a replacement for either — denies
     * this one call (same as Deny) AND drops a free-text comment into the run via #158's own steering
     * queue, so the model sees both together at the start of its next round: the call was rejected, and
     * here's why/what to do instead. The caller (ChatView.svelte) composes this from its own onDeny/onSteer
     * props — this component only collects the text.
     */
    onTalkAboutIt: (comment: string) => void
    /**
     * TASKS.md #201: the equal-and-opposite choice to onTalkAboutIt — "go ahead, but also …" instead of
     * "deny, because …". Runs the call (same validated/edited input `onApprove` would use) AND drops the
     * same comment into the run via #158's steering queue, so the model sees both together: the call's
     * real result, and the comment, at the start of its next round.
     */
    onApproveWithComment: (input: Record<string, unknown>, comment: string) => void
    /** Ends the whole turn right now, same as Stop during a normal response — distinct from Deny, which only rejects this one call and lets the turn keep going. Was always reachable before this was inline (a z-index fix kept the composer's own Stop button clickable over the old modal overlay) — kept as its own action here rather than silently dropped now that this replaces the composer instead of floating over it. */
    onStop: () => void
    onValidate: (input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
    onToggleAutoApprove: (value: boolean) => void
    onToggleAutoApproveTool: (value: boolean) => void
  } = $props()

  /** TASKS #234: a command or script is not limited to the workspace, so the dialog says when it mentions a protected or outside place. Checks the text as currently edited. */
  const isCommandRunner = $derived(isShellLikeTool(name))
  const warning = $derived.by(() => {
    if (!isCommandRunner) return null
    try {
      return commandWarning(name, JSON.parse(editedJson) as Record<string, unknown>)
    } catch {
      return commandWarning(name, input)
    }
  })

  let editedJson = $state('')
  /** The outside-the-workspace folder request (name "external_folder_access") is not a tool run: no editable JSON, no auto-approve, and — for reading — a choice of how long to remember the folder. */
  const isFolderAccess = $derived(name === 'external_folder_access')
  let remember = $state<'once' | 'session' | 'always'>('once')
  let jsonError = $state('')
  let secretValues = $state<Record<string, string>>({})
  let validating = $state(false)
  let validationError = $state('')
  /** TASKS.md #154 */
  let showTalkAboutIt = $state(false)
  let talkAboutItText = $state('')

  /**
   * Resets whenever this becomes a genuinely different confirmation request
   * (a new `toolUseId`), not just once at component-creation time. Found
   * live (a real Svelte compiler warning, `state_referenced_locally`, sat
   * unaddressed for a while): the previous version computed `editedJson`'s
   * initial value from a plain `const visibleInput = ...` derived from
   * `input`/`secretFields` directly — correct only for the very first
   * request a given component instance ever renders. Rendered inline now
   * (this used to be a modal, always torn down and recreated between
   * requests, which papered over the bug), reusing the same instance across
   * successive confirmations is the normal case, so this now has to hold up
   * on every request, not just the first.
   */
  $effect(() => {
    void toolUseId
    const visibleInput = Object.fromEntries(Object.entries(input).filter(([key]) => !secretFields.includes(key)))
    editedJson = JSON.stringify(visibleInput, null, 2)
    secretValues = Object.fromEntries(secretFields.map((f) => [f, '']))
    jsonError = ''
    validationError = ''
    validating = false
    showTalkAboutIt = false
    talkAboutItText = ''
    remember = 'once'
  })

  function sendTalkAboutIt(): void {
    const text = talkAboutItText.trim()
    if (!text) return
    onTalkAboutIt(text)
  }

  function combinedInput(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(editedJson) as Record<string, unknown>
      jsonError = ''
      for (const field of secretFields) {
        if (secretValues[field]) parsed[field] = secretValues[field]
      }
      return parsed
    } catch {
      jsonError = 'Input is not valid JSON.'
      return null
    }
  }

  /** Shared by approve() and approveWithComment() — same validated/edited input either way, only what happens with it once it's ready differs. */
  async function resolveApprovedInput(): Promise<Record<string, unknown> | null> {
    if (isFolderAccess) return { ...input, remember }
    const merged = combinedInput()
    if (!merged) return null

    if (hasValidation) {
      validating = true
      validationError = ''
      const result = await onValidate(merged)
      validating = false
      if (!result.ok) {
        validationError = result.error ?? 'Validation failed.'
        return null
      }
    }
    return merged
  }

  async function approve(): Promise<void> {
    const merged = await resolveApprovedInput()
    if (merged) onApprove(merged)
  }

  async function approveWithComment(): Promise<void> {
    const text = talkAboutItText.trim()
    if (!text) return
    const merged = await resolveApprovedInput()
    if (merged) onApproveWithComment(merged, text)
  }
</script>

<!-- Rendered inline in place of the composer (ChatView.svelte), not as a
     modal overlay — found live: the overlay's own pending state could go
     invisible with no way back to a usable composer short of restarting the
     app (Stop's fix for exactly this, App.svelte's stopGeneration, still
     applies here — it's the same underlying pendingConfirm/signal wiring,
     just a different rendering of it). Living in the one place already
     guaranteed visible whenever this session is on screen closes that gap
     structurally instead of relying on a separately-rendered layer. -->
<div class="confirm" role="group" aria-label="Tool call confirmation">
  <div class="confirm-header">
    {#if isFolderAccess}
      <h2>Allow access outside the workspace?</h2>
    {:else}
      <h2>Run <code>{name}</code>?</h2>
    {/if}
    <p class="description">{description}</p>
  </div>
  {#if isFolderAccess}
    {#if input.access === 'read'}
      <label class="remember">
        Remember this folder
        <select bind:value={remember}>
          <option value="once">Just this once</option>
          <option value="session">For this session</option>
          <option value="always">Always (listed in Settings, where you can remove it)</option>
        </select>
      </label>
    {/if}
  {:else}
    <textarea class="json" bind:value={editedJson} spellcheck="false"></textarea>
    {#if jsonError}<p class="error">{jsonError}</p>{/if}
    {#if warning}<p class="error" role="alert"><strong>{warning.level === 'protected' ? 'Protected location' : 'Check the path'}:</strong> {warning.text}</p>{/if}
  {/if}

  {#each secretFields as field (field)}
    <label class="secret-field">
      {field}
      <input type="password" bind:value={secretValues[field]} autocomplete="new-password" />
    </label>
  {/each}
  {#if validationError}<p class="error">{validationError}</p>{/if}

  {#if !isFolderAccess}
  <div class="confirm-row">
    <label class="auto-approve">
      <input
        type="checkbox"
        checked={autoApprove}
        disabled={isCommandRunner}
        onchange={(e) => onToggleAutoApprove((e.target as HTMLInputElement).checked)}
      />
      Auto-approve tool calls for this session{#if isCommandRunner}
        <span class="hint">(does not include <code>{name}</code>: a command is not limited to the workspace)</span>{/if}
    </label>
    <label class="auto-approve">
      <input
        type="checkbox"
        checked={autoApproveTool}
        onchange={(e) => onToggleAutoApproveTool((e.target as HTMLInputElement).checked)}
      />
      Always auto-approve <code>{name}</code>
    </label>
  </div>
  {/if}

  {#if showTalkAboutIt}
    <!-- TASKS.md #154/#201: a comment can go either way now — "deny, because …" (#154, the original) or
         "go ahead, but also …" (#201) — both drop the same free-text comment into the run via #158's
         steering queue; only whether this one call actually runs differs. -->
    <div class="talk-about-it">
      <!-- No Enter-to-submit here (unlike a plain steering note) — now that a comment can either deny
           or actually run this call, picking one of those on a bare Enter would be a real footgun;
           Enter/Shift+Enter both just insert a newline, and either action needs its own explicit click. -->
      <textarea class="talk-about-it-input" placeholder="What should it know? (either deny this call with your comment, or let it run and send the comment alongside)" bind:value={talkAboutItText}
      ></textarea>
      <div class="actions">
        <button type="button" class="ghost" onclick={() => (showTalkAboutIt = false)}>Cancel</button>
        <button type="button" onclick={sendTalkAboutIt} disabled={!talkAboutItText.trim()}> Deny &amp; send comment </button>
        <button type="button" class="primary" onclick={approveWithComment} disabled={!talkAboutItText.trim() || validating}>
          {validating ? 'Validating…' : 'Approve & send comment'}
        </button>
      </div>
    </div>
  {:else}
    <div class="actions">
      <button type="button" class="ghost" onclick={onStop} title="Ends the whole turn now, not just this one call">
        Stop turn
      </button>
      <div class="actions-right">
        <button type="button" onclick={() => (showTalkAboutIt = true)}>Talk about it</button>
        <button type="button" onclick={onDeny}>Deny</button>
        <button type="button" class="primary" onclick={approve} disabled={validating}>
          {validating ? 'Validating…' : 'Approve'}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .hint {
    color: var(--text-muted, #888);
    font-size: 0.85em;
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 0.8rem 1rem;
  }
  .confirm-header h2 {
    margin: 0;
    font-size: 0.9rem;
  }
  code {
    background: var(--panel-hover);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .remember {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }
  .remember select {
    flex: 1;
  }
  .description {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .json {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 4.5rem;
    max-height: 40vh;
    padding: 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .error {
    margin: 0;
    font-size: 0.75rem;
    color: var(--warn);
  }
  .secret-field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .secret-field input {
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 0.82rem;
  }
  .confirm-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.9rem;
  }
  .auto-approve {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    /* "Stop turn" (ends everything) sits apart on the left, away from the
       routine Deny/Approve pair for this one call, so the two kinds of
       decision aren't visually mixed together as equally-weighted options. */
    justify-content: space-between;
    gap: 0.5rem;
  }
  .actions-right {
    display: flex;
    gap: 0.5rem;
  }
  .actions .ghost {
    background: none;
    border-color: transparent;
    color: var(--text-muted);
  }
  .actions .ghost:hover {
    color: var(--text);
    border-color: var(--border);
  }
  /* TASKS.md #154 */
  .talk-about-it {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .talk-about-it-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 3rem;
    padding: 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
  }
  button {
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-hover);
    color: var(--text);
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
