import type { ContentBlock, Message, StreamEvent } from '@shared/protocol'
import type { AgentRole } from '@shared/agents'
import { AGENT_ROLE_LABELS, AGENT_ROLES } from '@shared/agents'
import { contextWindowFor, maxOutputTokensFor } from '@shared/model-metadata'
import type { ModelProvider, ToolDefinition } from '../providers/types'
import type { Tool, ToolContext } from '../tools/types'

export interface Agent {
  role: AgentRole
  /** One-line description used in the orchestrator's own system prompt to describe when to delegate here. */
  summary: string
  systemPrompt: string
  tools: Tool[]
  /**
   * Opt-in, per #77 — every existing role leaves this unset and keeps
   * today's exact behavior (full inherited conversation, shared round
   * budget). A `true` here changes `dispatchDelegate`'s two real
   * assumptions that are wrong for a bounded, self-contained, repeatedly-
   * invoked-per-turn role (e.g. a future "compose one slide" specialist):
   * the nested call gets only its own task/brief as context, not the
   * entire parent conversation, and its own fresh round budget (see
   * `maxRounds`) instead of sharing the parent's `MAX_TOTAL_ROUNDS` pool —
   * decoupling the *round ceiling* only; token usage still rolls up into
   * the parent's cumulative totals afterward, so cost accounting stays
   * honest and complete.
   */
  isolated?: boolean
  /** Only meaningful with `isolated: true` — the fresh round budget that role's own delegate calls get, capped independently of `MAX_TOTAL_ROUNDS`. Defaults to `MAX_TOTAL_ROUNDS` if omitted. */
  maxRounds?: number
}

export interface ConfirmDecision {
  approved: boolean
  input?: Record<string, unknown>
}

export interface ToolConfirmRequest {
  toolUseId: string
  name: string
  input: Record<string, unknown>
  description: string
  secretFields?: string[]
  hasValidation?: boolean
}

/**
 * What `Orchestrator.run` yields. Kept decoupled from Electron/the DB (no
 * `WebContents`, no direct `insertMessage` calls) so it stays unit-testable
 * against a mocked provider later (TASKS.md #59) — the caller in
 * ipc/register.ts does the actual IPC emit / DB persistence based on this.
 */
export type OrchestratorEvent =
  | { kind: 'stream'; event: StreamEvent }
  | { kind: 'message'; role: 'assistant' | 'user'; content: ContentBlock[] }

const MAX_TOTAL_ROUNDS = 12
const DELEGATE_PREFIX = 'delegate_to_'

/** See `capRepeatedToolResults` below. */
const MAX_KEPT_RESULTS_PER_TOOL = 3

/**
 * Repeated calls to the same read-only tool within a single turn — a
 * research agent refining a `web_search` query several times being the
 * concrete case this was built for — each stayed fully expanded in
 * `conversation` for every later round, since nothing else trims *within*
 * a turn: `prepareConversation` (ipc/register.ts) only runs once, before
 * the turn starts, against prior history, and `trimToolResults` only caps
 * a single oversized result, not the sum of many modest ones. Found live:
 * a real complex request made 9 separate `web_search` calls in one turn,
 * most refinements of a query that hadn't found what was needed yet, and
 * every one of those stayed in full for every subsequent round.
 *
 * Keeps only the most recent `MAX_KEPT_RESULTS_PER_TOOL` results for each
 * tool name in what's actually sent to the provider; older ones collapse
 * to a one-line marker (the original tool_use input block is untouched and
 * still cheap, so the model can still see *what* it already tried, just
 * not the full result again). Only applies to a tool whose `mutates` is
 * statically `false` — a completed write/mutating call represents a real
 * side effect worth remembering in full for as long as it's in context;
 * a stale read is safely re-fetchable if actually still needed. Never
 * mutates `conversation` itself (returns a fresh array only when there's
 * something to collapse) — this only ever affects what's sent to the
 * provider on this and later rounds, never what's persisted to SQLite or
 * shown in the live/reloaded UI transcript, same as every other trimming
 * pass in this codebase.
 */
function capRepeatedToolResults(conversation: Message[], toolByName: ReadonlyMap<string, Tool>): Message[] {
  const idsByName = new Map<string, string[]>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      const tool = toolByName.get(b.name)
      if (!tool || tool.mutates !== false) continue
      const ids = idsByName.get(b.name) ?? []
      ids.push(b.id)
      idsByName.set(b.name, ids)
    }
  }
  const staleIds = new Set<string>()
  for (const ids of idsByName.values()) {
    if (ids.length <= MAX_KEPT_RESULTS_PER_TOOL) continue
    for (const id of ids.slice(0, ids.length - MAX_KEPT_RESULTS_PER_TOOL)) staleIds.add(id)
  }
  if (staleIds.size === 0) return conversation

  return conversation.map((m) => ({
    ...m,
    content: m.content.map((b): ContentBlock => {
      if (b.type !== 'tool_result' || !staleIds.has(b.toolUseId)) return b
      return {
        ...b,
        content: '[Earlier result omitted to save context — this tool was called again later in the same turn. See the tool_use input above for what was tried.]'
      }
    })
  }))
}

const DUPLICATE_URL_OVERLAP_THRESHOLD = 0.7

/** Every http(s) URL literally present in a string — deliberately generic (not web_search-specific) so it also catches e.g. parse_html's link listing. */
function extractUrls(text: string): Set<string> {
  return new Set(text.match(/https?:\/\/\S+/g) ?? [])
}

/**
 * Collapses a read-only tool's result when it returns (almost) the same
 * URLs an earlier call to the *same* tool already returned earlier in this
 * turn — found live: chasing a document that wasn't findable, a research
 * agent kept rewording its `web_search` query, and each reworded attempt
 * surfaced the same handful of articles again, ballooning context with
 * duplicate coverage instead of new information (confirmed against a real
 * session: 9 near-identical queries for a "Disha Salian FIR pdf" that
 * doesn't exist as a directly-searchable document, all returning mostly
 * the same sources). Detected by literal URL overlap, not semantic
 * similarity, so a genuinely different result — even for a
 * superficially-similar-looking query — is left untouched. A tool's first
 * appearance in the turn is never collapsed (nothing to compare against
 * yet); only overlap with *prior* calls of the same tool counts. Runs
 * before, and independently of, `capRepeatedToolResults`' pure recency cap
 * below — that one still applies afterward as a hard backstop even when no
 * duplicate is detected here (e.g. many genuinely distinct searches).
 */
function collapseDuplicateToolResults(conversation: Message[], toolByName: ReadonlyMap<string, Tool>): Message[] {
  const toolNameByUseId = new Map<string, string>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      const tool = toolByName.get(b.name)
      if (tool && tool.mutates === false) toolNameByUseId.set(b.id, b.name)
    }
  }

  const seenUrlsByTool = new Map<string, Set<string>>()
  const duplicateIds = new Set<string>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      const toolName = toolNameByUseId.get(b.toolUseId)
      if (!toolName) continue
      const urls = extractUrls(b.content)
      if (urls.size === 0) continue
      const seen = seenUrlsByTool.get(toolName)
      if (seen) {
        const overlap = [...urls].filter((u) => seen.has(u)).length / urls.size
        if (overlap >= DUPLICATE_URL_OVERLAP_THRESHOLD) duplicateIds.add(b.toolUseId)
      }
      const union = seen ?? new Set<string>()
      for (const u of urls) union.add(u)
      seenUrlsByTool.set(toolName, union)
    }
  }
  if (duplicateIds.size === 0) return conversation

  return conversation.map((m) => ({
    ...m,
    content: m.content.map((b): ContentBlock => {
      if (b.type !== 'tool_result' || !duplicateIds.has(b.toolUseId)) return b
      return {
        ...b,
        content:
          '[Result omitted — its sources substantially overlap an earlier search this turn. Rewording the query again is unlikely to surface anything new; try a different approach, or tell the user this could not be found.]'
      }
    })
  }))
}

function delegateToolName(role: AgentRole): string {
  return DELEGATE_PREFIX + role.replace(/-/g, '_')
}

function roleFromDelegateName(name: string, agents: Map<AgentRole, Agent>): AgentRole | undefined {
  if (!name.startsWith(DELEGATE_PREFIX)) return undefined
  const slug = name.slice(DELEGATE_PREFIX.length).replace(/_/g, '-') as AgentRole
  return agents.has(slug) ? slug : undefined
}

/** Tags text/tool_use/warning events for UI attribution (the "X agent" chip) — safe at any nesting level, including the top level in forced-role mode. */
function tagEvent(event: StreamEvent, agentRole: AgentRole | undefined): StreamEvent {
  if (!agentRole) return event
  if (event.type === 'text_delta') return { ...event, agentRole }
  if (event.type === 'tool_use_start') return { ...event, agentRole }
  if (event.type === 'status') return { ...event, agentRole }
  if (event.type === 'warning') return { ...event, agentRole }
  return event
}

/**
 * A nested specialist's own message_stop must be distinguishable from the
 * whole exchange truly ending, or the renderer can't tell them apart and
 * stops listening early — found live: a delegated call's own tool_result
 * and the orchestrator's real final reply were both silently dropped
 * because the specialist's own end_turn looked identical to the whole
 * conversation's end_turn. Tagging is keyed on nesting level, not on
 * whether agentRole is set: in forced-role mode the *top-level* call
 * itself carries an agentRole (for the chip), but its own message_stop is
 * still the true final one — found live too, as a stuck "sending" state
 * that never re-enabled the composer after a forced-role reply.
 */
function tagMessageStop(
  event: Extract<StreamEvent, { type: 'message_stop' }>,
  agentRole: AgentRole | undefined,
  isTopLevel: boolean
): StreamEvent {
  return isTopLevel || !agentRole ? event : { ...event, agentRole }
}

interface AccumulatedToolCall {
  id: string
  name: string
  inputJson: string
  thoughtSignature?: string
}

/** Shared across every nesting level of one `run()` call — the round cap, cumulative token usage, and per-round output budget all need to span top-level + every delegate. */
interface RunState {
  roundsUsed: number
  inputTokens: number
  outputTokens: number
  maxOutputTokens: number
}

const MIN_MAX_OUTPUT_TOKENS = 4096 // today's original flat value — kept as the floor, not the ceiling
const OUTPUT_TOKENS_FRACTION = 0.5 // leave room for at least one more similarly-sized round within the same turn

export interface PlanStep {
  role: AgentRole
  description: string
}

interface Plan {
  complexity: 'simple' | 'compound'
  steps: PlanStep[]
}

/** A sub-task's own result folded back into the shared conversation is capped
 * before being added — otherwise plan execution could reintroduce the exact
 * context-bloat failure it exists to prevent (a large `search_history` step
 * result was what triggered the original hallucinated-tool-call bug). */
const STEP_RESULT_CONTEXT_CAP = 2000

const VALID_STEP_ROLES = new Set<string>(AGENT_ROLES)

/** Fails open to `undefined` (treated as "simple" by the caller) on any parse/shape problem — a broken classifier response must never block the turn it's meant to help. */
function parsePlan(text: string): Plan | undefined {
  try {
    const stripped = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
    const parsed = JSON.parse(stripped)
    if (parsed.complexity !== 'simple' && parsed.complexity !== 'compound') return undefined
    if (!Array.isArray(parsed.steps)) return undefined
    const steps: PlanStep[] = []
    for (const s of parsed.steps) {
      if (typeof s?.description !== 'string' || !s.description.trim()) return undefined
      if (typeof s?.role !== 'string' || !VALID_STEP_ROLES.has(s.role)) return undefined
      steps.push({ role: s.role as AgentRole, description: s.description })
    }
    return { complexity: parsed.complexity, steps }
  } catch {
    return undefined
  }
}

/**
 * The Orchestrator owns the conversation: it can act directly with its own
 * default tools, or delegate a step to a specialized Agent (sequential
 * hand-off, no concurrent agents — see thouthts.md). Delegation is modeled
 * as an ordinary tool call (`delegate_to_<role>`) rather than a separate
 * routing phase, so it reuses the same proven multi-round tool-call loop
 * (streaming, human-in-loop confirmation, a shared round-safety-cap) at
 * every nesting level instead of a second parallel state machine. Nested
 * specialists don't get delegate tools themselves, so recursion is capped
 * at exactly one level.
 */
export class Orchestrator {
  constructor(
    private readonly provider: ModelProvider,
    private readonly model: string,
    private readonly agents: Map<AgentRole, Agent>,
    private readonly defaultSystemPrompt: string,
    private readonly defaultTools: Tool[],
    private readonly confirmTool: (request: ToolConfirmRequest) => Promise<ConfirmDecision>,
    private readonly toolContext: ToolContext,
    private readonly signal: AbortSignal,
    /**
     * Defaults to disabled so existing/unit-test callers that construct an
     * Orchestrator directly without scripting an extra classify turn keep
     * working unchanged — the real app (ipc/register.ts) always passes this
     * explicitly, computed from the persisted `planningEnabled` setting
     * (default on there, not here).
     */
    private readonly options: { planningEnabled: boolean } = { planningEnabled: false }
  ) {}

  /**
   * Runs one user turn. If `forcedRole` is set (manual override — see
   * TASKS.md orchestrator plan), skips the orchestrator's own routing
   * entirely and runs that specialist directly, with no delegate tools of
   * its own available. Otherwise (Auto mode), optionally runs a
   * classify-and-plan pass first (see `classifyAndPlan`) — a genuinely
   * compound result routes through `executePlan`'s structured step
   * execution instead of pure round-by-round improvisation; anything else
   * (simple, planning disabled, or a failed/malformed classification) falls
   * straight through to the same behavior this always had.
   */
  async *run(conversation: Message[], forcedRole?: AgentRole | null): AsyncIterable<OrchestratorEvent> {
    const maxOutputTokens = await this.resolveMaxOutputTokens(conversation)
    const state: RunState = { roundsUsed: 0, inputTokens: 0, outputTokens: 0, maxOutputTokens }

    if (forcedRole) {
      const agent = this.agents.get(forcedRole)
      if (!agent) throw new Error(`Unknown agent role "${forcedRole}".`)
      const systemPrompt = agent.systemPrompt + this.buildForcedModeNotice(forcedRole)
      yield* this.runLoop(systemPrompt, agent.tools, conversation, state, forcedRole, [], true)
      return
    }

    const plan = this.options.planningEnabled ? yield* this.classifyAndPlan(conversation, state) : undefined

    if (!plan || plan.steps.length <= 1) {
      yield* this.runLoop(
        this.buildOrchestratorSystemPrompt(),
        this.defaultTools,
        conversation,
        state,
        undefined,
        this.buildDelegateToolDefinitions(),
        true
      )
      return
    }

    yield* this.executePlan(plan, conversation, state)
  }

  /**
   * The per-round output-token ceiling. Was a single flat `4096` forever,
   * for every provider/model/round, unrelated to any real capacity — found
   * live that this starved `gpt-oss` into an empty response
   * (`finish_reason: "length"`, zero visible output; its hidden
   * chain-of-thought reasoning counts against `maxTokens` before any
   * visible output is produced), and separately, confirmed against each
   * provider's own current docs that ordinary cloud replies had been capped
   * to a fraction of their real ceiling the whole time (e.g. Claude Sonnet
   * 5/Opus 5 really allow 128,000).
   *
   * Now: `maxOutputTokensFor(this.model)` (model-metadata.ts) gives the
   * real, provider-enforced ceiling — this is a hard clamp, never exceeded,
   * so a cloud model never gets asked for more than it actually accepts (a
   * new class of hard API error otherwise). The *budget* within that
   * ceiling scales off how much of the model's context window is actually
   * free: a live reading when a provider can give one (today, Ollama's
   * `loadedContextWindow`, a real `/api/ps` read of what's actually
   * loaded), else the same static estimate `prepare-context.ts` already
   * uses for input-side trimming. `countTokens` is a real network call for
   * Anthropic/Google, but only once per turn (see `run()`), matching the
   * cost this app already pays during history trimming before the
   * Orchestrator is even constructed.
   */
  private async resolveMaxOutputTokens(conversation: Message[]): Promise<number> {
    const ceiling = maxOutputTokensFor(this.model).tokens
    const loaded = await this.provider.loadedContextWindow?.(this.model)
    const windowTokens = loaded ?? contextWindowFor(this.model).tokens
    const used = await this.provider.countTokens(conversation, this.model)
    const remaining = Math.max(0, windowTokens - used)
    const budget = Math.floor(remaining * OUTPUT_TOKENS_FRACTION)
    return Math.min(ceiling, Math.max(MIN_MAX_OUTPUT_TOKENS, budget))
  }

  /**
   * One dedicated, tool-free call ahead of the normal round loop — asks the
   * model to judge whether the request needs more than one distinct
   * sub-task and, if so, produce an ordered step list up front. Found live:
   * a genuinely compound request could wander into an irrelevant,
   * hallucinated tool call once retrieved context grew large mid-turn —
   * this replaces that per-round discretion with a structural, upfront
   * gate. Counts against the same shared `state.roundsUsed` cap as every
   * other round. A genuine provider failure rethrows (surfaced like any
   * other error, same as `runLoop`); an aborted signal returns `undefined`
   * quietly, since the very next `runLoop`/`dispatchDelegate` call will hit
   * the same aborted signal and produce the real "aborted" stop event.
   *
   * Sends only the latest message, not the full conversation — found live,
   * repeatedly, against the real default model (gpt-oss): given the full
   * history (which, past the first turn, always includes an earlier
   * tool_use/tool_result exchange and a natural-language assistant reply),
   * it would drift into just answering the user's question directly,
   * completely ignoring the classify instruction — confirmed directly
   * against the real server across several trials, ~0% valid-JSON rate
   * with full history vs. ~85% with just the latest message alone. The
   * classify task only needs the current request's own phrasing to judge
   * structural complexity; the full history actively hurts reliability
   * here by giving the model an established "just chat" pattern to fall
   * back into instead of the structured-output task.
   */
  private async *classifyAndPlan(
    conversation: Message[],
    state: RunState
  ): AsyncGenerator<OrchestratorEvent, Plan | undefined> {
    state.roundsUsed++
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    let roundUsage: { inputTokens: number; outputTokens: number } | undefined
    const latestMessage = conversation[conversation.length - 1]

    try {
      for await (const event of this.provider.stream({
        model: this.model,
        system: this.buildClassifySystemPrompt(),
        messages: latestMessage ? [latestMessage] : conversation,
        // Shares the same real, scaled-when-possible budget as every other
        // round (see resolveMaxOutputTokens) — a flat small value here
        // starved gpt-oss's hidden reasoning into an empty response before
        // this existed (finish_reason:"length", 0 visible chars).
        maxTokens: state.maxOutputTokens,
        signal: this.signal
      })) {
        if (event.type === 'text_delta') text += event.text
        else if (event.type === 'usage') roundUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
        else if (event.type === 'message_stop') stopReason = event.stopReason
      }
    } catch (err) {
      if (!this.signal.aborted) throw err
      return undefined
    }

    if (roundUsage) {
      state.inputTokens += roundUsage.inputTokens
      state.outputTokens += roundUsage.outputTokens
      yield { kind: 'stream', event: { type: 'usage', ...roundUsage } }
    }

    const plan = parsePlan(text)
    if (!plan) {
      if (stopReason === 'max_tokens') {
        // Surfaced to the user, not just logged — this is the one real
        // correctness concern the classify pass can hit: a genuinely
        // empty/cut-off response (hit the output-token limit) used to be
        // silently indistinguishable from "the model decided nothing
        // needed planning," hiding a real bug. Fail-open (proceed as a
        // normal request) is still the right recovery either way.
        const message =
          "Couldn't tell whether this request is simple or compound (the classification response was cut off " +
          'before it could finish, hitting the output-token limit) — treating it as a normal request instead.'
        yield { kind: 'stream', event: { type: 'warning', message } }
        yield { kind: 'message', role: 'assistant', content: [{ type: 'warning', message }] }
      } else {
        // A local model (gpt-oss especially) not returning valid JSON for
        // this structured-output probe is the *expected*, routine case, not
        // a real problem — fail-open the same way, but only to the console,
        // not the chat transcript. Reported directly: a persisted warning
        // here had no actionable next step for the user and just read as
        // noise on every turn it happened to fire.
        console.error('orchestrator: classify-and-plan response was not valid JSON, treating as a normal request')
      }
    }
    return plan
  }

  /**
   * Walks a compound plan's steps in order, each one dispatched exactly
   * like today's single delegate call, then runs one final top-level round
   * so the model can synthesize everything the steps produced into the
   * actual answer. `plan`/`plan_step_start`/`plan_step_done` are live-only
   * UI signal — the real content of each step is already a normal
   * persisted message via the same `dispatchDelegate` machinery every other
   * delegated round already uses, so a reloaded session still shows the
   * full text even though the live checklist animation doesn't replay.
   */
  private async *executePlan(plan: Plan, conversation: Message[], state: RunState): AsyncIterable<OrchestratorEvent> {
    yield { kind: 'stream', event: { type: 'plan', steps: plan.steps } }

    for (const [index, step] of plan.steps.entries()) {
      yield { kind: 'stream', event: { type: 'plan_step_start', index } }
      const result = yield* this.dispatchDelegate(step.role, { task: step.description }, conversation, state)
      yield { kind: 'stream', event: { type: 'plan_step_done', index, isError: result.isError } }

      const trimmed =
        result.content.length > STEP_RESULT_CONTEXT_CAP
          ? result.content.slice(0, STEP_RESULT_CONTEXT_CAP) + '\n[...truncated for context budget...]'
          : result.content
      const stepMessage: Message = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[Plan step ${index + 1} — ${AGENT_ROLE_LABELS[step.role]}]: ${step.description}\n\nResult:\n${trimmed}`
          }
        ]
      }
      yield { kind: 'message', role: 'user', content: stepMessage.content }
      conversation.push(stepMessage)
    }

    yield* this.runLoop(
      this.buildOrchestratorSystemPrompt(),
      this.defaultTools,
      conversation,
      state,
      undefined,
      this.buildDelegateToolDefinitions(),
      true
    )
  }

  /**
   * Built from `this.agents`' own `summary` strings — the same source
   * `buildOrchestratorSystemPrompt` already uses — rather than a bare role
   * enum. Found live: given only role names, the classifier sometimes
   * assigned a lookup step to Planning (reasoning-only, no tools at all)
   * instead of Research, which actually has `search_history`/`web_search`.
   * The run self-corrected in the final synthesis round (which still has
   * every tool available), but a plan step should be routed to a role that
   * can actually do it.
   */
  private buildClassifySystemPrompt(): string {
    const specialists = [...this.agents.values()]
      .map((a) => `- ${a.role}: ${a.summary}${a.tools.length === 0 ? ' (no tools of its own — reasoning/text only)' : ''}`)
      .join('\n')
    return (
      "Before anything else, classify the user's latest request and, only if it genuinely needs more " +
      'than one distinct sub-task, build a short ordered plan for it. You have no tools available for ' +
      'this — do not attempt to call one. Respond with ONLY a single JSON object, no markdown fence, ' +
      'no other text, and do not answer the request itself here:\n' +
      '{"complexity": "simple" | "compound", "steps": [{"role": "<one of the role ids below>", ' +
      '"description": "..."}]}\n' +
      '- "simple": answerable directly, or with at most one tool call or delegation. Use an empty steps ' +
      'array or a single entry.\n' +
      '- "compound": genuinely separate sub-tasks (e.g. two independent lookups, or a lookup followed by ' +
      "a separate calculation) that each need a specialist's tools. List each as its own ordered step, " +
      "tagging the role whose tools can actually do it — don't route a step needing a tool to a role " +
      "with no tools. If a sub-part needs no tool at all (pure reasoning, or combining results already " +
      "gathered), don't give it its own step — it belongs in the final answer instead.\n" +
      "Keep the step count small and don't over-decompose a genuinely simple request into multiple " +
      `trivial steps just to look thorough.\n\nRoles:\n${specialists}`
    )
  }

  private buildOrchestratorSystemPrompt(): string {
    const specialists = [...this.agents.values()]
      .map((a) => `- ${AGENT_ROLE_LABELS[a.role]} (${delegateToolName(a.role)}): ${a.summary}`)
      .join('\n')
    return (
      `${this.defaultSystemPrompt}\n\n` +
      'You can also delegate a step to a specialist by calling its delegate tool when the task clearly ' +
      'fits one of these roles — especially anything substantial involving code or files, which should ' +
      `usually go to the Coding specialist rather than being handled directly:\n${specialists}\n\n` +
      'For simple or general requests, just answer directly (or use your own tools) without delegating.'
    )
  }

  /**
   * Forced-role mode (the composer's "Agent: X" mode picker pinned away
   * from "Auto") skips the orchestrator and its delegate tools entirely, so
   * a pinned specialist has no mechanism to hand off even when the request
   * clearly needs a different one. Found live: a session pinned to Research
   * was asked to save/convert a file, and — having no visibility into the
   * other specialists at all — replied "I'm the only agent running in this
   * conversation," which is only true because of the pin, not a real
   * capability gap. This notice gives the pinned specialist enough
   * awareness to name the right specialist and point the user back to the
   * mode picker, instead of claiming no other agents exist.
   */
  private buildForcedModeNotice(currentRole: AgentRole): string {
    const others = [...this.agents.values()]
      .filter((a) => a.role !== currentRole)
      .map((a) => `- ${AGENT_ROLE_LABELS[a.role]}: ${a.summary}`)
      .join('\n')
    return (
      '\n\n---\n' +
      `You are currently pinned to the ${AGENT_ROLE_LABELS[currentRole]} specialist only (the ` +
      'composer\'s "Agent:" selector, bottom-left, is set away from "Auto") — you cannot hand off to ' +
      'another specialist yourself right now, even when one clearly fits the request better, and you ' +
      "have no delegate tools available. If the user's request needs a capability outside your own " +
      "tools, don't say you have no other agents or no way to do it at all — name which specialist " +
      'would actually handle it from this list, and tell the user to switch the "Agent:" selector to ' +
      `"Auto" (so the orchestrator can delegate automatically) or directly to that specialist:\n${others}`
    )
  }

  /**
   * A real, honestly-scoped "what's happening" hint for the round about to
   * start — genuinely distinguishes the very first call of a run/specialist
   * (nothing to go on yet but the model itself) from a later round that's
   * actually reacting to a tool result, rather than a generic "Thinking…"
   * for both. Deliberately doesn't try to describe the model's own
   * reasoning content — no provider in this app streams that as a separate
   * signal, so anything more specific than "thinking" / "reviewing tool
   * results" would be a guess, not a real report.
   *
   * Includes the shared round budget (`state.roundsUsed`/MAX_TOTAL_ROUNDS)
   * — reported directly: with only a static "Thinking…" to look at, a long
   * multi-round turn (this app's own real round-cap investigation involved
   * exactly this) reads as stuck/unresponsive even while genuinely
   * progressing. A real "round 3/12" counter is honest, cheap progress
   * signal the renderer already has everything it needs to show.
   */
  private roundStatusMessage(agentRole: AgentRole | undefined, localRound: number, state: RunState, maxRounds: number): string {
    const activity = localRound === 1 ? 'thinking' : 'reviewing tool results'
    const progress = `(round ${state.roundsUsed}/${maxRounds})`
    return agentRole
      ? `${AGENT_ROLE_LABELS[agentRole]} agent is ${activity}… ${progress}`
      : `Model (${this.model}) is ${activity}… ${progress}`
  }

  private buildDelegateToolDefinitions(): ToolDefinition[] {
    return [...this.agents.values()].map((a) => ({
      name: delegateToolName(a.role),
      description: `Hand off to the ${AGENT_ROLE_LABELS[a.role]} specialist: ${a.summary}`,
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string', description: 'What the specialist should do' } },
        required: ['task']
      }
    }))
  }

  /**
   * The shared round-loop: streams one provider turn, handles any resulting
   * tool calls (delegate or registry), and repeats until the model stops
   * calling tools or the shared round budget is exhausted. Used both for
   * the top-level call and, recursively via `yield*`, for every specialist's
   * own turn — which is what gives multi-hop chaining, per-round
   * confirmation, and the round cap "for free" at every nesting level.
   */
  private async *runLoop(
    systemPrompt: string,
    tools: Tool[],
    conversation: Message[],
    state: RunState,
    agentRole: AgentRole | undefined,
    extraToolDefs: ToolDefinition[] = [],
    isTopLevel = false,
    maxRounds: number = MAX_TOTAL_ROUNDS
  ): AsyncGenerator<OrchestratorEvent, { text: string; isError: boolean }> {
    const toolByName = new Map(tools.map((t) => [t.name, t]))
    const toolDefs: ToolDefinition[] = [
      ...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...extraToolDefs
    ]
    // Local to this runLoop call (unlike state.roundsUsed, which is the
    // shared safety cap across the whole run) — just distinguishes "first
    // call this specialist/the top level has made" from "continuing after
    // seeing a tool result," for the status message below.
    let localRound = 0

    while (state.roundsUsed < maxRounds) {
      state.roundsUsed++
      localRound++

      yield {
        kind: 'stream',
        event: tagEvent(
          { type: 'status', message: this.roundStatusMessage(agentRole, localRound, state, maxRounds) },
          agentRole
        )
      }

      let assistantText = ''
      const toolCalls: AccumulatedToolCall[] = []
      const toolCallsById = new Map<string, AccumulatedToolCall>()
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
      // Some providers (Anthropic, Gemini) repeat a *cumulative* usage total
      // across several chunks within one round rather than sending it once —
      // confirmed live. Keep only the last one seen and report it as this
      // round's own contribution below, or every consumer downstream would
      // double/triple-count if they summed the raw events.
      let roundUsage: { inputTokens: number; outputTokens: number } | undefined

      try {
        for await (const event of this.provider.stream({
          model: this.model,
          system: systemPrompt,
          messages: capRepeatedToolResults(collapseDuplicateToolResults(conversation, toolByName), toolByName),
          maxTokens: state.maxOutputTokens,
          tools: toolDefs.length ? toolDefs : undefined,
          signal: this.signal
        })) {
          if (event.type === 'text_delta') {
            assistantText += event.text
          } else if (event.type === 'tool_use_start') {
            const call: AccumulatedToolCall = {
              id: event.id,
              name: event.name,
              inputJson: '',
              thoughtSignature: event.thoughtSignature
            }
            toolCalls.push(call)
            toolCallsById.set(event.id, call)
          } else if (event.type === 'tool_use_delta') {
            const call = toolCallsById.get(event.id)
            if (call) call.inputJson += event.partialInput
          } else if (event.type === 'message_stop') {
            stopReason = event.stopReason
          } else if (event.type === 'usage') {
            roundUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
            continue
          }
          const outEvent =
            event.type === 'message_stop' ? tagMessageStop(event, agentRole, isTopLevel) : tagEvent(event, agentRole)
          yield { kind: 'stream', event: outEvent }
        }
      } catch (err) {
        // The signal is the source of truth for "was this a user-requested
        // stop" — every provider SDK throws its own differently-shaped abort
        // error, and pattern-matching on error names/types across all 4
        // would be brittle. A genuine failure (network error, bad request,
        // etc.) rethrows unchanged, preserving today's error surfacing.
        if (!this.signal.aborted) throw err
        yield { kind: 'stream', event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, agentRole, isTopLevel) }
        return { text: assistantText, isError: true }
      }

      if (roundUsage) {
        state.inputTokens += roundUsage.inputTokens
        state.outputTokens += roundUsage.outputTokens
        yield { kind: 'stream', event: { type: 'usage', ...roundUsage } }
      }

      const assistantBlocks: ContentBlock[] = []
      if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText, agentRole })
      if (stopReason === 'max_tokens') {
        // Found live against gpt-oss (empty response) before this existed —
        // don't silently treat a truncated round as a normal, complete one.
        // Whatever text/tool calls DID make it through above are kept, not
        // discarded; this just tells the user/caller the round was cut off
        // before it necessarily finished.
        const message = `This response was cut off after reaching the ${state.maxOutputTokens}-token output limit for this round — it may be incomplete.`
        assistantBlocks.push({ type: 'warning', message, agentRole })
        yield { kind: 'stream', event: tagEvent({ type: 'warning', message }, agentRole) }
      }
      const inputByCallId = new Map<string, Record<string, unknown>>()
      for (const call of toolCalls) {
        let input: Record<string, unknown> = {}
        try {
          input = call.inputJson ? JSON.parse(call.inputJson) : {}
        } catch {
          // Malformed tool input is surfaced back to the model as an error result below.
        }
        inputByCallId.set(call.id, input)
        assistantBlocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input,
          agentRole,
          thoughtSignature: call.thoughtSignature
        })
      }
      // Snapshot before appending this round's assistant blocks: a delegate call's
      // nested conversation must NOT include the orchestrator's own (not-yet-resolved)
      // delegate_to_x tool_use as its last message — OpenAI's API rejects an assistant
      // message with tool_calls that isn't immediately followed by matching tool
      // responses, and the specialist doesn't need to see that internal routing call
      // anyway. (Found live: a real 400 from OpenAI on the first delegation attempt.)
      const conversationBeforeThisRound = [...conversation]

      if (assistantBlocks.length) yield { kind: 'message', role: 'assistant', content: assistantBlocks }
      conversation.push({ role: 'assistant', content: assistantBlocks })

      if (stopReason !== 'tool_use' || toolCalls.length === 0) {
        return { text: assistantText, isError: stopReason === 'max_tokens' }
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolCalls) {
        const input = inputByCallId.get(call.id) ?? {}
        const delegateRole = roleFromDelegateName(call.name, this.agents)

        let content: string
        let isError: boolean
        if (delegateRole) {
          const result = yield* this.dispatchDelegate(delegateRole, input, conversationBeforeThisRound, state)
          content = result.content
          isError = result.isError
        } else {
          const result = await this.dispatchTool(call.id, call.name, input, toolByName)
          content = result.content
          isError = result.isError
        }

        resultBlocks.push({ type: 'tool_result', toolUseId: call.id, content, isError })
        yield { kind: 'stream', event: { type: 'tool_result', toolUseId: call.id, content, isError } }
      }
      yield { kind: 'message', role: 'user', content: resultBlocks }
      conversation.push({ role: 'user', content: resultBlocks })
    }

    // Round budget exhausted — rather than discarding everything gathered
    // so far and returning a bare "ran out of rounds" stub, make one final,
    // tools-disabled call asking the model to synthesize a real answer
    // from what's already in `conversation`. Found live, and worse than it
    // first looked: `state.roundsUsed` is shared across the *entire* run,
    // not scoped per delegate call — so once a nested plan-step delegate
    // exhausted the budget, executePlan's own top-level synthesis call
    // (whose whole job is weaving plan-step results into a real final
    // answer) hit the identical exhausted counter and fell through to this
    // same stub too, immediately, without running a single round. The
    // user's real question had already turned up a genuinely relevant,
    // on-topic result (a real news article) sitting untouched in
    // `conversation` when this used to just discard it all. This wrap-up
    // call runs unconditionally here regardless of how far over budget
    // `state.roundsUsed` already is — every call site that hits this path
    // gets exactly one real chance to summarize instead of stub out.
    let wrapUpText = ''
    try {
      for await (const event of this.provider.stream({
        model: this.model,
        system:
          `${systemPrompt}\n\nYou have used all ${maxRounds} rounds available for this turn — no ` +
          'more tool calls are possible. Answer now using only what has already been found above: ' +
          "summarize the real information gathered so far, and say plainly if it's incomplete, rather " +
          'than attempting anything further.',
        messages: capRepeatedToolResults(collapseDuplicateToolResults(conversation, toolByName), toolByName),
        maxTokens: state.maxOutputTokens,
        signal: this.signal
        // No `tools` — forces a text-only reply, so this genuinely cannot loop further.
      })) {
        if (event.type === 'text_delta') wrapUpText += event.text
        if (event.type === 'usage') {
          state.inputTokens += event.inputTokens
          state.outputTokens += event.outputTokens
        }
        // Every event forwarded the same way the main loop above does,
        // message_stop included — found live in review, not yet in
        // production: an earlier draft of this wrap-up only forwarded
        // text_delta/usage, silently dropping message_stop. The renderer's
        // "is this turn actually finished" detection depends on seeing a
        // real (correctly tagged) message_stop; without one, this fix
        // would have traded a visible-but-unhelpful stub for a genuinely
        // stuck-looking composer — the exact symptom being fixed.
        const outEvent =
          event.type === 'message_stop' ? tagMessageStop(event, agentRole, isTopLevel) : tagEvent(event, agentRole)
        yield { kind: 'stream', event: outEvent }
      }
    } catch (err) {
      if (!this.signal.aborted) throw err
      return { text: wrapUpText, isError: true }
    }

    if (wrapUpText) {
      yield { kind: 'message', role: 'assistant', content: [{ type: 'text', text: wrapUpText, agentRole }] }
      return { text: wrapUpText, isError: false }
    }

    return { text: `Stopped after ${maxRounds} agent rounds.`, isError: true }
  }

  /**
   * `this.confirmTool` only ever resolves via the renderer's Approve/Deny
   * click (see `makeConfirmTool` in ipc/register.ts) — it has no idea the
   * signal exists. Found live: clicking Stop while a confirmation dialog is
   * open did nothing, because `dispatchTool` was awaiting that bare promise
   * with no path back to the round loop's own abort handling. Racing it
   * against the signal here treats "stop while waiting on you" the same as
   * a denial, which lets this round finish immediately; the *next*
   * `provider.stream()` call then hits the loop's existing `signal.aborted`
   * check and ends the run with the normal "aborted" message_stop, so no
   * separate abort-specific stop reason is needed here.
   */
  private confirmOrAbort(request: ToolConfirmRequest): Promise<ConfirmDecision> {
    if (this.signal.aborted) return Promise.resolve({ approved: false })
    return new Promise((resolve) => {
      const onAbort = (): void => resolve({ approved: false })
      this.signal.addEventListener('abort', onAbort, { once: true })
      this.confirmTool(request).then((decision) => {
        this.signal.removeEventListener('abort', onAbort)
        resolve(decision)
      })
    })
  }

  /** A specialist's own tool calls (e.g. Coding calling write_file) still go through normal confirmation. */
  private async dispatchTool(
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    toolByName: Map<string, Tool>
  ): Promise<{ content: string; isError: boolean }> {
    const tool = toolByName.get(name)
    if (!tool) {
      return { content: `Unknown tool "${name}".`, isError: true }
    }

    const mutates = typeof tool.mutates === 'function' ? tool.mutates(input) : tool.mutates
    if (mutates) {
      const decision = await this.confirmOrAbort({
        toolUseId,
        name: tool.name,
        input,
        description: tool.describe?.(input) ?? JSON.stringify(input),
        secretFields: tool.secretFields,
        hasValidation: tool.validate !== undefined
      })
      if (!decision.approved) {
        return { content: 'The user denied this tool call.', isError: true }
      }
      input = decision.input ?? input
    }

    try {
      const content = await tool.execute(input, this.toolContext)
      return { content, isError: false }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  /**
   * Recursively runs the chosen specialist's own loop, forwarding every
   * intermediate event via `yield*` so the caller sees it live, then wraps
   * the specialist's final answer as this delegate call's tool_result.
   * Errors from the nested loop (e.g. a provider/network failure) are
   * contained here — turned into an isError result for just this one
   * delegate call — rather than propagating up and killing the whole turn.
   */
  private async *dispatchDelegate(
    role: AgentRole,
    input: Record<string, unknown>,
    conversation: Message[],
    state: RunState
  ): AsyncGenerator<OrchestratorEvent, { content: string; isError: boolean }> {
    const agent = this.agents.get(role)
    if (!agent) return { content: `Unknown agent role "${role}".`, isError: true }

    const task = String(input.task ?? '')
    const taskMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: `[Orchestrator -> ${AGENT_ROLE_LABELS[role]}]: ${task}` }]
    }
    // Isolated (#77): only this brief, not the whole parent conversation —
    // and a fresh round budget, not the shared MAX_TOTAL_ROUNDS pool, so a
    // role invoked repeatedly per turn (once per slide, say) can't
    // collectively exhaust the budget the rest of the turn still needs.
    const nestedConversation: Message[] = agent.isolated ? [taskMessage] : [...conversation, taskMessage]
    const nestedState: RunState = agent.isolated
      ? { roundsUsed: 0, inputTokens: 0, outputTokens: 0, maxOutputTokens: state.maxOutputTokens }
      : state
    const maxRounds = agent.isolated ? (agent.maxRounds ?? MAX_TOTAL_ROUNDS) : MAX_TOTAL_ROUNDS

    try {
      const result = yield* this.runLoop(
        agent.systemPrompt,
        agent.tools,
        nestedConversation,
        nestedState,
        role,
        [],
        false,
        maxRounds
      )
      // The round ceiling is decoupled for an isolated call, but its real
      // token cost isn't — roll up into the parent's cumulative totals so
      // session_usage/the context meter still see the true full cost.
      if (agent.isolated) {
        state.inputTokens += nestedState.inputTokens
        state.outputTokens += nestedState.outputTokens
      }
      return { content: result.text || '(no response)', isError: result.isError }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
