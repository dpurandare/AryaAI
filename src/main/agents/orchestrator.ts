import { randomUUID } from 'node:crypto'
import type { ContentBlock, Message, StreamEvent } from '@shared/protocol'
import type { AgentRole } from '@shared/agents'
import { AGENT_ROLE_LABELS, AGENT_ROLES } from '@shared/agents'
import { contextWindowFor, maxOutputTokensFor } from '@shared/model-metadata'
import { evaluateClassifyGate, shouldSampleForCalibration, type ClassifyGateVerdict } from './classify-gate'
import { CONTEXT_BUDGET_FRACTION, overheadTokens, resolveContextWindow } from '../context/prepare-context'
import type { ModelProvider, ToolDefinition } from '../providers/types'
import type { Tool, ToolContext } from '../tools/types'

export interface Agent {
  role: AgentRole
  /** One-line description used in the orchestrator's own system prompt to describe when to delegate here. */
  summary: string
  systemPrompt: string
  tools: Tool[]
  /**
   * Opt-in, per #77 — every existing role leaves this unset. A `true` here
   * changes only `dispatchDelegate`'s conversation scoping: the nested call
   * gets just its own task/brief as context instead of the entire parent
   * conversation, for a bounded, self-contained, repeatedly-invoked-per-turn
   * role (e.g. a "compose one slide" specialist) that doesn't need — and
   * ideally shouldn't see — everything said so far. Every delegate call,
   * isolated or not, already gets its own fresh round budget (see
   * `maxRounds`); token usage still always rolls up into the parent's
   * cumulative totals, so cost accounting stays honest and complete either
   * way.
   */
  isolated?: boolean
  /** The fresh round budget this role's own delegate calls get — every delegate call has always had its own pool, isolated or not (found live: a single turn-wide shared pool let one delegate's legitimate multi-step work starve the rest of the turn). Defaults to `MAX_TOTAL_ROUNDS` if omitted. */
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
 * Asked whenever a turn/delegate call's round or time budget runs out —
 * found live: the existing wrap-up-and-summarize behavior (see runLoop's
 * exhaustion handling) is the right *default* recovery, but for a turn that
 * was making genuine, still-succeeding progress (a real multi-step Docker
 * build/debug cycle, not a runaway loop), silently finalizing a summary
 * instead of actually finishing the work isn't always what the user wants.
 * `requestId` is fresh every time — the same turn/delegate call can hit this
 * more than once if granted more budget and then exhausts that too.
 */
export interface LimitReachedRequest {
  requestId: string
  reason: 'rounds' | 'time'
  roundsUsed: number
  maxRounds: number
  /** The specialist whose own delegate call hit the limit — undefined for the top-level turn itself. */
  agentRole?: AgentRole
}

export interface LimitDecision {
  /** True grants a fresh round budget (and, if the reason was 'time', a fresh wall-clock deadline) and resumes; false proceeds to the existing wrap-up-and-summarize behavior. */
  continueWorking: boolean
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

/**
 * The round ceiling each call to `runLoop` gets on its own — the top-level
 * turn, and (since every delegate call now gets its own fresh pool rather
 * than sharing one turn-wide budget — see `dispatchDelegate`) each
 * individual delegate call too. Deliberately generous now that it's scoped
 * per-call rather than shared: was 12 and shared turn-wide, which a real,
 * completely legitimate session (clone a repo, read 4 files, delegate a
 * multi-step Docker build/debug/fix cycle — nothing looping or wasted) hit
 * mid-task, with the container not yet confirmed working. `TURN_DEADLINE_MS`
 * remains the real backstop against a turn actually running too long; this
 * exists mainly to catch genuine runaway loops, not to ration ordinary work.
 */
const MAX_TOTAL_ROUNDS = 20
const DELEGATE_PREFIX = 'delegate_to_'

/**
 * How long a single provider round is allowed to run before being treated
 * as hung and stopped the same way a user-clicked Stop already is. Found
 * live: a real turn (a rich multi-slide presentation) sat completely
 * unresponsive for over an hour with zero visible error and Stop unable to
 * help — confirmed directly against the running process that nothing was
 * actually pending (no open network connection, no pending Promise
 * anywhere in the heap), meaning the round had already died silently with
 * no bound on how long the app would just sit there before anyone noticed.
 * 5 minutes is generous for a legitimately slow local model composing
 * something complex (seen live taking several minutes for one real round)
 * but not infinite — every round now has a hard ceiling.
 *
 * This is the ceiling for a round's *first* attempt only — see
 * `startRoundTimer`'s adaptive budget, which grows on each consecutive
 * retry. A flat 5-minute ceiling applied identically to every retry was
 * itself found live to be a second bug on top of the original hang: on
 * timeout, the retry resends the exact same prompt/context with no
 * adaptation, so a round that genuinely needs close to or over 5 minutes
 * can never converge — every attempt gets killed just before finishing and
 * restarts from zero, burning the whole turn deadline on repeated wasted
 * restarts while surfacing a warning that looks like a failure each time.
 */
const ROUND_TIMEOUT_MS = 5 * 60 * 1000

/** Never budget a round less than this, even one started with almost no turn time left (e.g. the final wrap-up call). */
const ROUND_TIMEOUT_FLOOR_MS = 30 * 1000

/** Always reserve at least this much of the remaining turn budget when sizing a round's timeout, so ending a round never leaves literally zero time for the next attempt or the final wrap-up call. */
const ROUND_TIMEOUT_SAFETY_MARGIN_MS = 60 * 1000

/**
 * A hard wall-clock ceiling on one whole turn, top-level rounds and every
 * delegate call combined — not just a per-round bound. Found live: a
 * single request (a rich presentation) ran past an hour with no end in
 * sight even before it silently died; a fixed per-round timeout alone
 * still lets a turn with many legitimately-slow rounds run indefinitely
 * long in aggregate. Checked at the top of every `runLoop` iteration
 * (top-level and every delegate, isolated or not — they all share the
 * same `state.deadlineAt`, see `RunState`); once past it, `runLoop` stops
 * starting new rounds the exact same way running out of `maxRounds`
 * already does, falling into the existing round-cap wrap-up path so
 * whatever's real gets synthesized into an actual answer instead of
 * silently cut off.
 */
const TURN_DEADLINE_MS = 15 * 60 * 1000

/**
 * A ceiling on one `tool.execute()` call. Found live: the round-timeout
 * above only wraps `provider.stream()` — once a round ends in a tool call,
 * `dispatchTool`'s `await tool.execute(...)` has no timeout and isn't tied
 * to `this.signal` (Stop) at all, so a tool that never resolves (a stalled
 * write, a hung network call inside a tool with no timeout of its own)
 * reproduces the exact "sat unresponsive for over an hour, Stop unable to
 * cancel it" bug the round-timeout was built to fix, just one step later in
 * the same loop. This can't force-cancel whatever the tool is actually
 * doing (`Tool.execute` takes no signal) — same limitation the round timer
 * itself accepts for a stalled provider connection — but it guarantees the
 * orchestrator's own wait, and so the whole turn, is never blocked forever.
 */
const TOOL_EXECUTE_TIMEOUT_MS = 5 * 60 * 1000

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

/** Shared by `runLoop` (what's actually sent to the provider) and `resolveMaxOutputTokens` (what overhead to budget for). */
function toToolDefs(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

/** The latest message's own plain text, for the classify-gate heuristic (classify-gate.ts) — ignores tool_use/tool_result/warning blocks, same as a user's actual typed request would read. */
function latestMessageText(conversation: Message[]): string {
  const latest = conversation[conversation.length - 1]
  if (!latest) return ''
  return latest.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/**
 * A cheap, local, provider-independent stand-in for a real `countTokens`
 * call — deliberately conservative (an undercount of real tokens-per-char
 * only ever makes this *more* likely to trigger the real check below, never
 * less) so `refitConversationToBudget` can skip the real check entirely on
 * the overwhelming majority of ordinary rounds, where the conversation is
 * nowhere near the budget. Never used as the actual trim decision once the
 * real check has run — only to gate whether that real check (a genuine
 * network call for Anthropic/Google) happens at all, and to decide how many
 * results to collapse without re-calling the provider after each one.
 */
const ROUGH_CHARS_PER_TOKEN = 3

function roughTokenEstimate(conversation: Message[]): number {
  let chars = 0
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length
      else if (b.type === 'tool_result') chars += b.content.length
      else if (b.type === 'tool_use') chars += b.name.length + JSON.stringify(b.input).length
    }
  }
  return Math.ceil(chars / ROUGH_CHARS_PER_TOKEN)
}

const CONTEXT_FIT_OMITTED_MARKER =
  "[Earlier tool result omitted to fit this round in the model's context window — see the tool_use input " +
  'above for what was tried; the original result is still too large together with everything else gathered ' +
  'so far this turn.]'

/**
 * The actual mid-turn collapse `refitConversationToBudget` falls back to —
 * same shape as `capRepeatedToolResults`' own collapse, but ordered purely
 * by conversation position (oldest first) rather than grouped per tool name,
 * since the goal here is "make this fit," not "cap repetition of one tool."
 * Only touches a non-mutating tool's result (a completed mutation is a real
 * side effect worth remembering in full, same reasoning as
 * `capRepeatedToolResults`) that isn't already collapsed (skips anything
 * already short — cheaper than string-comparing every possible placeholder
 * marker, and an already-small result was never the problem). `fits` is
 * called with the cheap rough estimator between each collapse, not a real
 * `countTokens` call, so this stays a single real API call total even when
 * several results need collapsing.
 */
function collapseOldestToolResultsToFit(
  conversation: Message[],
  toolByName: ReadonlyMap<string, Tool>,
  fits: (messages: Message[]) => boolean
): Message[] {
  const toolNameByUseId = new Map<string, string>()
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type === 'tool_use') toolNameByUseId.set(b.id, b.name)
    }
  }
  const collapsibleIdsInOrder: string[] = []
  for (const m of conversation) {
    for (const b of m.content) {
      if (b.type !== 'tool_result' || b.content.length < 200) continue
      const tool = toolByName.get(toolNameByUseId.get(b.toolUseId) ?? '')
      if (tool && tool.mutates === false) collapsibleIdsInOrder.push(b.toolUseId)
    }
  }

  let working = conversation
  for (const id of collapsibleIdsInOrder) {
    if (fits(working)) break
    working = working.map((m) => ({
      ...m,
      content: m.content.map((b): ContentBlock =>
        b.type === 'tool_result' && b.toolUseId === id ? { ...b, content: CONTEXT_FIT_OMITTED_MARKER } : b
      )
    }))
  }
  return working
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

/** Shared across every nesting level of one `run()` call — the round cap, cumulative token usage, and per-round output budget all need to span top-level + every delegate. `deadlineAt` is likewise shared (never reset, even for an isolated delegate's own fresh `roundsUsed`) — a per-slide page-creator call getting its own round budget was never meant to let the *whole turn* run past its own wall-clock cap. */
interface RunState {
  roundsUsed: number
  inputTokens: number
  outputTokens: number
  maxOutputTokens: number
  deadlineAt: number
  /** How many round-timeouts in a row have just happened at this nesting level — reset to 0 the moment a round actually completes, incremented on each timeout. Grows the next round's timeout budget (see `startRoundTimer`) so a retry gets more room than the attempt that just wasn't enough, instead of blindly repeating the same losing timeout forever. */
  consecutiveRoundTimeouts: number
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

/**
 * A hard ceiling on how many steps a single classify-and-plan pass can hand
 * to `executePlan` — flagged by an external code review (`review.md`,
 * TASKS.md #94): `parsePlan` used to accept any length, and an oversized
 * plan could burn most of the turn's shared round/deadline budget on
 * redundant specialist calls before the final synthesis round even started.
 * Truncated rather than rejected outright — a plan with 8 genuinely
 * reasonable steps is still mostly useful with only the first 5 kept; the
 * caller surfaces a warning so this isn't silent.
 */
const MAX_PLAN_STEPS = 5

const VALID_STEP_ROLES = new Set<string>(AGENT_ROLES)

/** Fails open to `undefined` (treated as "simple" by the caller) on any parse/shape problem — a broken classifier response must never block the turn it's meant to help. */
function parsePlan(text: string): { plan: Plan; truncated: boolean } | undefined {
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
    const truncated = steps.length > MAX_PLAN_STEPS
    return { plan: { complexity: parsed.complexity, steps: truncated ? steps.slice(0, MAX_PLAN_STEPS) : steps }, truncated }
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
     * `planningEnabled` defaults to disabled so existing/unit-test callers
     * that construct an Orchestrator directly without scripting an extra
     * classify turn keep working unchanged — the real app (ipc/register.ts)
     * always passes this explicitly, computed from the persisted
     * `planningEnabled` setting (default on there, not here).
     *
     * `confirmContinue` defaults to absent, in which case runLoop's
     * exhaustion handling falls straight to today's existing wrap-up
     * behavior unchanged — every existing caller/test that doesn't pass it
     * keeps working exactly as before; only a caller that wants the
     * ask-before-abandoning behavior needs to provide it.
     *
     * `logClassifyGateSample` defaults to absent (a no-op) — see TASKS.md
     * #95: every time `classifyAndPlan`'s real classifier call actually
     * runs, this is handed the deterministic gate's own verdict alongside
     * the real result, purely for the calibration logging ipc/register.ts
     * wires to `db/classify-gate-log.ts`. Optional/no-op by default so
     * every existing caller/test that doesn't care about calibration data
     * keeps working unchanged — this file stays DB-free either way (see
     * this class's own doc comment).
     */
    private readonly options: {
      planningEnabled: boolean
      confirmContinue?: (request: LimitReachedRequest) => Promise<LimitDecision>
      logClassifyGateSample?: (sample: {
        gateVerdict: ClassifyGateVerdict
        classifierComplexity: 'simple' | 'compound' | 'unknown'
        messageLength: number
      }) => void
    } = { planningEnabled: false }
  ) {}

  /**
   * A per-round AbortSignal that fires on whichever comes first: the real
   * user/turn-level `this.signal`, or this round's own timeout budget
   * elapsing. Every `provider.stream()` call site passes `roundSignal`
   * instead of `this.signal` directly, and checks `roundSignal.aborted`
   * (not `this.signal.aborted`) in its catch block — so a timeout is
   * handled by the exact same, already-tested "clean abort" path a real
   * Stop click already goes through, not a new/parallel one. `timedOut()`
   * lets the caller tell the two apart afterward, only to choose a more
   * honest message ("this took too long" vs "you stopped it") — never to
   * change the control flow itself. Always call `clear()` once the round's
   * own stream has actually finished (in a `finally`), or the timer leaks
   * and can fire long after the round it was guarding is already done.
   *
   * The budget is adaptive, not the flat `ROUND_TIMEOUT_MS` for every
   * attempt: `consecutiveRoundTimeouts` (how many times in a row this exact
   * round has just been retried after timing out) roughly doubles the
   * ceiling each time, so a round that's merely slow — not hung — gets
   * more room on each retry instead of being killed at the identical point
   * forever. Still bounded by the actual remaining turn budget (with a
   * safety margin reserved for whatever runs next) and a floor so even a
   * round started with almost no time left gets a workable window.
   */
  private startRoundTimer(
    deadlineAt: number,
    consecutiveRoundTimeouts: number
  ): { signal: AbortSignal; timedOut: () => boolean; clear: () => void; budgetMs: number } {
    if (this.signal.aborted) {
      return { signal: this.signal, timedOut: () => false, clear: () => {}, budgetMs: 0 }
    }
    const controller = new AbortController()
    let didTimeOut = false
    const onParentAbort = (): void => controller.abort()
    this.signal.addEventListener('abort', onParentAbort, { once: true })
    const remaining = deadlineAt - Date.now()
    const budgetMs = Math.max(
      ROUND_TIMEOUT_FLOOR_MS,
      Math.min(remaining - ROUND_TIMEOUT_SAFETY_MARGIN_MS, ROUND_TIMEOUT_MS * (consecutiveRoundTimeouts + 1))
    )
    const timer = setTimeout(() => {
      didTimeOut = true
      controller.abort()
    }, budgetMs)
    return {
      signal: controller.signal,
      timedOut: () => didTimeOut,
      budgetMs,
      clear: () => {
        clearTimeout(timer)
        this.signal.removeEventListener('abort', onParentAbort)
      }
    }
  }

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
    const state: RunState = {
      roundsUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      maxOutputTokens,
      deadlineAt: Date.now() + TURN_DEADLINE_MS,
      consecutiveRoundTimeouts: 0
    }

    if (forcedRole) {
      const agent = this.agents.get(forcedRole)
      if (!agent) throw new Error(`Unknown agent role "${forcedRole}".`)
      const systemPrompt = agent.systemPrompt + this.buildForcedModeNotice(forcedRole)
      yield* this.runLoop(systemPrompt, agent.tools, conversation, state, forcedRole, [], true)
      return
    }

    // Phase 1 of TASKS.md #95: a cheap deterministic pre-check ahead of the
    // real classifier call — 'skip' only fires on an unambiguous, short,
    // single-clause message (see classify-gate.ts), so this never decides
    // "compound" itself, only whether the real call is worth skipping.
    // Phase 2: even a 'skip' verdict is sometimes overridden anyway
    // (shouldSampleForCalibration) purely so the real classifier still runs
    // and its result can be logged against the gate's own verdict — see
    // classifyAndPlan's own logging call below.
    const gateVerdict: ClassifyGateVerdict = this.options.planningEnabled
      ? evaluateClassifyGate(latestMessageText(conversation))
      : 'run'
    const shouldClassify = this.options.planningEnabled && (gateVerdict !== 'skip' || shouldSampleForCalibration())
    const plan = shouldClassify ? yield* this.classifyAndPlan(conversation, state, gateVerdict) : undefined

    // Stop clicked while classifyAndPlan's own request was in flight: it
    // already swallowed that abort quietly and returned `undefined` (same
    // shape as "no plan needed"), relying on *this* check to actually end
    // the turn — found live: without it, an aborted classify pass fell
    // straight through into a brand-new full round below, silently
    // discarding the user's Stop and spending a whole extra model call
    // (with its own visible "round 1" status flicker) before anything
    // acknowledged the cancellation. Scoped to `shouldClassify` specifically
    // — with planning off, or the gate skipping the classify call entirely,
    // `plan` is `undefined` because there was never a classify call to
    // abort, and runLoop below is the *first* real attempt this turn; it
    // must still run so its own status/abort handling fires normally (a
    // signal already aborted before the user even sent this turn is a real,
    // if rare, case that existing behavior already covers).
    if (shouldClassify && this.signal.aborted) {
      yield { kind: 'stream', event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, undefined, true) }
      return
    }

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
   * uses for input-side trimming.
   *
   * Also subtracts real overhead (system prompt + tool schemas) before
   * computing what's left — flagged by an external code review (`review.md`,
   * TASKS.md #97): this used to only subtract `countTokens(conversation)`,
   * so the `MIN_MAX_OUTPUT_TOKENS` floor could still request more output
   * than was actually free once the system prompt and tool definitions sent
   * in the same request were accounted for, especially for a small local
   * model's context window. Reuses `overheadTokens` (`prepare-context.ts`,
   * already built for #51's input-side trim) rather than a second estimator.
   * The exact system prompt/tool set used varies per round (forced-role vs.
   * Auto, a specialist's own smaller tool list, the classify pass's empty
   * one) but `state.maxOutputTokens` is computed once and shared across
   * every round and every nested delegate call in the whole run (see
   * `RunState`) — so the top-level orchestrator's own prompt plus the full
   * default tool registry (`buildOrchestratorSystemPrompt`/`defaultTools`)
   * is used as the worst-case (largest) overhead estimate every round
   * actually uses, which only ever makes the budget more conservative for a
   * smaller specialist prompt/tool set, never short of what's really free.
   *
   * `countTokens` is a real network call for Anthropic/Google — now two per
   * turn (conversation + overhead), not one, but still only at `run()`
   * startup, not per round, matching the cost this app already pays during
   * history trimming before the Orchestrator is even constructed.
   */
  private async resolveMaxOutputTokens(conversation: Message[]): Promise<number> {
    const ceiling = maxOutputTokensFor(this.model).tokens
    const loaded = await this.provider.loadedContextWindow?.(this.model)
    const windowTokens = loaded ?? contextWindowFor(this.model).tokens
    const used = await this.provider.countTokens(conversation, this.model)
    const overhead = await overheadTokens(
      { system: this.buildOrchestratorSystemPrompt(), tools: toToolDefs(this.defaultTools) },
      this.model,
      this.provider
    )
    const remaining = Math.max(0, windowTokens - used - overhead)
    const budget = Math.floor(remaining * OUTPUT_TOKENS_FRACTION)
    return Math.min(ceiling, Math.max(MIN_MAX_OUTPUT_TOKENS, budget))
  }

  /**
   * Re-fits the conversation against the context window before every
   * provider request, not just once via `prepareConversation` before the
   * turn starts — flagged by an external code review (`review.md`,
   * TASKS.md #98): `capRepeatedToolResults`/`collapseDuplicateToolResults`
   * already dedupe by tool name and URL overlap, but nothing previously
   * re-checked *total* conversation size mid-turn, so `executePlan`'s
   * appended step results or an ordinary long multi-round tool-call
   * sequence could each individually stay under their local caps while the
   * sum still pushed a later round's request over the model's real context
   * window.
   *
   * Deliberately two-tier to avoid turning every single round into an extra
   * real network call: `roughTokenEstimate` (a cheap, local, conservative
   * char-count approximation) decides whether the *real* `countTokens` check
   * even needs to run at all, so an ordinary short conversation — the
   * overwhelming majority of rounds — returns immediately with zero added
   * cost or latency. Only once the rough estimate suggests real risk does
   * this spend a real `countTokens` call (a genuine network request for
   * Anthropic/Google) to confirm, and only then collapse the oldest
   * still-expanded, non-mutating tool results (oldest first, cheapest-to-
   * re-fetch-if-still-needed) until it's estimated to fit — re-measured with
   * the same cheap local estimator between collapses, never a real call per
   * collapse, so this stays at most one real `countTokens` call per round
   * even in a turn that needs several results collapsed.
   */
  private async refitConversationToBudget(
    messages: Message[],
    toolByName: ReadonlyMap<string, Tool>,
    systemPrompt: string,
    toolDefs: ToolDefinition[],
    state: RunState
  ): Promise<Message[]> {
    const contextWindow = await resolveContextWindow(this.model, this.provider)
    const roughBudget = Math.floor(contextWindow.tokens * CONTEXT_BUDGET_FRACTION) - state.maxOutputTokens
    if (roughTokenEstimate(messages) <= roughBudget) return messages

    const overhead = await overheadTokens({ system: systemPrompt, tools: toolDefs }, this.model, this.provider)
    const budget = Math.max(0, roughBudget - overhead)
    const actual = await this.provider.countTokens(messages, this.model)
    if (actual <= budget) return messages

    return collapseOldestToolResultsToFit(messages, toolByName, (candidate) => roughTokenEstimate(candidate) <= budget)
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
    state: RunState,
    gateVerdict: ClassifyGateVerdict
  ): AsyncGenerator<OrchestratorEvent, Plan | undefined> {
    state.roundsUsed++
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    let roundUsage: { inputTokens: number; outputTokens: number } | undefined
    const latestMessage = conversation[conversation.length - 1]

    // Always a fresh (non-retried) budget — this is a one-shot probe that
    // falls open on timeout rather than retrying, so the adaptive growth
    // that a real retry loop gets doesn't apply here.
    const roundTimer = this.startRoundTimer(state.deadlineAt, 0)
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
        signal: roundTimer.signal
      })) {
        if (event.type === 'text_delta') text += event.text
        else if (event.type === 'usage') roundUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
        else if (event.type === 'message_stop') stopReason = event.stopReason
      }
    } catch (err) {
      if (!roundTimer.signal.aborted) throw err
      // A timed-out classify call falls open exactly like a genuinely
      // malformed one already does (see the no-plan branch below) — it's
      // a probe, not the real answer, so there's nothing here worth
      // surfacing beyond just proceeding without a plan.
      return undefined
    } finally {
      roundTimer.clear()
    }

    if (roundUsage) {
      state.inputTokens += roundUsage.inputTokens
      state.outputTokens += roundUsage.outputTokens
      yield { kind: 'stream', event: { type: 'usage', ...roundUsage } }
    }

    const parsed = parsePlan(text)
    if (parsed?.truncated) {
      const message =
        `This request's plan had more steps than the ${MAX_PLAN_STEPS}-step limit — proceeding with just the ` +
        'first ones; the rest of the request may need a follow-up turn.'
      yield { kind: 'stream', event: { type: 'warning', message } }
      yield { kind: 'message', role: 'assistant', content: [{ type: 'warning', message }] }
    }
    const plan = parsed?.plan
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
    // Phase 2 of TASKS.md #95 — a real classifier response, whatever it was
    // (including "unparseable"), logged alongside the gate's own verdict for
    // this turn. Only reached once the call actually completed (the
    // timeout/abort path above returns before this), so this never logs a
    // probe that never got a real answer.
    this.options.logClassifyGateSample?.({
      gateVerdict,
      classifierComplexity: plan?.complexity ?? 'unknown',
      messageLength: latestMessageText(conversation).length
    })
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
      // `result.isError` used to only reach the renderer (the plan_step_done
      // event just above, for its ✓/✗ UI) — the text below, the only copy
      // of this step's outcome any later step or the final synthesis round
      // actually sees, formatted a failure identically to a real result.
      // Nothing distinguished "here is your data" from "here is why I
      // couldn't get your data" except the prose itself, which a later step
      // has no structural reason to scrutinize — it could just as easily
      // treat an error string as content to summarize/write into a report.
      // The explicit (FAILED...) marker is what a step actually reacts to.
      const stepLabel = `[Plan step ${index + 1} — ${AGENT_ROLE_LABELS[step.role]}]${
        result.isError ? ' (FAILED — no usable result)' : ''
      }`
      const stepMessage: Message = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${stepLabel}: ${step.description}\n\nResult:\n${trimmed}`
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
    // Filtered to AGENT_ROLES, same set VALID_STEP_ROLES validates a
    // parsed plan's steps against (parsePlan) — `this.agents` itself has
    // every role including page-creator, which is deliberately NOT a valid
    // plan-step target (see shared/agents.ts's own doc comment: isolated,
    // delegate-only, expects a specific one-slide brief). Listing it here
    // anyway previously let the classifier believe it was a real option,
    // even though selecting it would just make parsePlan silently reject
    // the whole plan — wasted, confusing classify calls that were never
    // going to produce a usable plan either way.
    const specialists = [...this.agents.values()]
      .filter((a) => (AGENT_ROLES as readonly string[]).includes(a.role))
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
      '- "compound": genuinely separate sub-tasks (e.g. two independent lookups, a lookup followed by ' +
      'a separate calculation, or — found live, a real miss — gathering information and THEN saving/' +
      'producing a deliverable from it, e.g. "look up X and write it into a Word document/spreadsheet/' +
      'file") that each need a specialist\'s tools. List each as its own ordered step, tagging the role ' +
      "whose tools can actually do it — don't route a step needing a tool to a role with no tools, and " +
      "never fold a whole multi-part request like that into a single step for whichever role matches " +
      "its first/dominant verb (e.g. routing \"search for X and write it to a Word doc\" entirely to " +
      'research as one "simple" step) — research has no file-writing tools at all, so the document part ' +
      'would just silently never happen. Any part of the request that asks for a saved file/document/' +
      'spreadsheet output is its own step for coding (or whichever role actually has that tool), after ' +
      "the step(s) that gather what goes into it. If a sub-part needs no tool at all (pure reasoning, or " +
      "combining results already gathered), don't give it its own step — it belongs in the final answer " +
      'instead.\n' +
      'A request needing code to be written AND actually run (e.g. "generate a chart image from this ' +
      'data") is two separate steps, never one — found live: routed as a single "coding" step, it wrote ' +
      'a Python script, tried to run it directly, hit "Unknown tool" (coding has no shell access at all), ' +
      "and reported success anyway without the file ever existing. coding writes the script as its step; " +
      'a separate, later "terminal-devops" step actually runs it — never assume one role can do both just ' +
      'because the task reads as one sentence.\n' +
      'Building a slide deck/presentation is never a plan step for any role, "coding" included — ' +
      'coding has no deck-building tools at all and falls back to a much worse plain-bullet-list output ' +
      "if forced into it (found live). Deck-building only happens in the top-level's own final round, " +
      'directly, via pptx_start_deck + delegate_to_page-creator per slide — never a delegated step. If ' +
      'the request needs research before the deck can be built, plan the research as its own step; leave ' +
      'the actual deck construction out of the plan entirely so it happens in that final round.\n' +
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
      ...toToolDefs(tools),
      ...extraToolDefs
    ]
    // Local to this runLoop call (unlike state.roundsUsed, which is the
    // shared safety cap across the whole run) — just distinguishes "first
    // call this specialist/the top level has made" from "continuing after
    // seeing a tool result," for the status message below.
    let localRound = 0

    while (state.roundsUsed < maxRounds && Date.now() < state.deadlineAt) {
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

      const messagesToSend = await this.refitConversationToBudget(
        capRepeatedToolResults(collapseDuplicateToolResults(conversation, toolByName), toolByName),
        toolByName,
        systemPrompt,
        toolDefs,
        state
      )
      const roundTimer = this.startRoundTimer(state.deadlineAt, state.consecutiveRoundTimeouts)
      try {
        for await (const event of this.provider.stream({
          model: this.model,
          system: systemPrompt,
          messages: messagesToSend,
          maxTokens: state.maxOutputTokens,
          tools: toolDefs.length ? toolDefs : undefined,
          signal: roundTimer.signal
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
        // roundTimer.signal (not this.signal) is checked here specifically
        // so a round-timeout — this round alone taking past its own budget
        // — is recognized as a clean abort too, not rethrown as a genuine
        // error.
        if (!roundTimer.signal.aborted) throw err
        if (!roundTimer.timedOut()) {
          // A real user Stop click — ends the whole turn now, as before.
          yield { kind: 'stream', event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, agentRole, isTopLevel) }
          return { text: assistantText, isError: true }
        }
        // A genuine round-timeout that the provider surfaced as a thrown
        // error — fall through to the shared roundTimer.timedOut() handling
        // below, the same as the silent-completion shape.
      } finally {
        roundTimer.clear()
      }

      /**
       * A round-timeout can surface in two completely different shapes for
       * the exact same underlying cause (this round's own timer fired and
       * called `controller.abort()`), depending on how the provider's SDK
       * reacts to an aborted request:
       *  1. It rejects the in-flight promise/iterator (Anthropic's and
       *     Google's SDKs, confirmed live) — caught above, handled in the
       *     `catch` block.
       *  2. It doesn't throw at all (the `openai` SDK — used for both
       *     OpenAI itself and Ollama's OpenAI-compat endpoint — confirmed
       *     live and by direct reproduction: aborting a stalled stream ends
       *     its async iterator cleanly, no exception). `streamOpenAICompatible`
       *     then hits its own end-of-stream fallback and yields an ordinary-
       *     looking empty `end_turn`, which used to be silently misread as
       *     "the model produced no output" — ending the whole round/turn
       *     with a warning that blamed "a known quirk with local reasoning
       *     models," instead of retrying with more time. `provider.requests`
       *     stayed at 1 for the entire remaining turn budget in a real
       *     reproduction of this — the retry path was never reached at all.
       * Checking `roundTimer.timedOut()` directly here — after the try/catch
       * either fell through or was caught above — is what makes the retry
       * fire for shape 2 as well as shape 1.
       */
      if (this.signal.aborted && !roundTimer.timedOut() && !assistantText && toolCalls.length === 0) {
        // A genuine user Stop, surfaced via shape 2 above (no thrown error)
        // — same "the user asked for this, not a timeout" outcome the catch
        // block already gives shape 1, just reached without an exception to
        // catch. Narrowed to "no real content produced" so a round that
        // actually finished at the same instant Stop happened to be clicked
        // still gets to keep its real answer instead of being discarded.
        yield {
          kind: 'stream',
          event: tagMessageStop({ type: 'message_stop', stopReason: 'aborted' }, agentRole, isTopLevel)
        }
        return { text: assistantText, isError: true }
      }

      if (roundTimer.timedOut()) {
        // A round-timeout is NOT a user Stop — ending the whole turn over
        // one slow round would be exactly as bad as the bug this exists to
        // fix (one stuck slide killing an otherwise-fine presentation).
        // Report it and let the loop continue to the next round instead —
        // still bounded by the normal maxRounds/state.deadlineAt checks
        // above, same as any other round. Growing the budget here (rather
        // than resetting to 0) is what the next startRoundTimer call reads
        // to give the retry more room than this attempt got.
        state.consecutiveRoundTimeouts++
        const message =
          `The model hasn't finished responding after over ${Math.round(roundTimer.budgetMs / 60000)} ` +
          "minute(s) — this is generation time on a slow model, not a tool being stuck. Giving it more " +
          'time and trying again.'
        yield { kind: 'stream', event: tagEvent({ type: 'warning', message }, agentRole) }
        continue
      }

      // The round actually completed (whether or not it timed out on a
      // *previous* attempt) — the next round starts a fresh escalation from
      // here, not compounding on unrelated future slowness.
      state.consecutiveRoundTimeouts = 0

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
      } else if (!assistantText && toolCalls.length === 0) {
        // A second, distinct empty-response shape from the max_tokens one
        // above — found live against gpt-oss/Ollama on a long, tool-heavy
        // conversation: the server's own stream ended cleanly
        // (finish_reason "stop", not "length" — the output budget was never
        // exhausted) yet produced no visible content and no tool call at
        // all. Ollama surfaces gpt-oss's chain-of-thought as a separate
        // `reasoning` delta field this app deliberately never reads (see
        // streamOpenAICompatible) — confirmed live that the model can spend
        // an entire round reasoning and then just stop, past reasoning
        // grown long enough. Previously this ended the turn in total
        // silence: no persisted message, no visible error, nothing —
        // indistinguishable from the app having done nothing at all.
        const message =
          'The model produced no visible output for this response (no text, no tool call) — a known quirk ' +
          'with local reasoning models on longer or more complex requests. Try asking again.'
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
        return { text: assistantText, isError: stopReason === 'max_tokens' || !assistantText }
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

    const outOfTime = Date.now() >= state.deadlineAt

    // Ask before abandoning, rather than always silently wrapping up — a
    // no-op (askToContinue immediately resolves continueWorking: false)
    // unless the caller opted in via options.confirmContinue, so every
    // existing caller/test keeps today's exact unchanged behavior. Granting
    // more budget just resets the counters and re-enters this same method
    // via yield* — a fresh call, not a special retry path, so it goes
    // through the exact same round loop (and can hit this exact same
    // question again if it also runs out).
    const continueDecision = await this.askToContinue({
      requestId: randomUUID(),
      reason: outOfTime ? 'time' : 'rounds',
      roundsUsed: state.roundsUsed,
      maxRounds,
      agentRole
    })
    if (continueDecision.continueWorking) {
      state.roundsUsed = 0
      if (outOfTime) state.deadlineAt = Date.now() + TURN_DEADLINE_MS
      return yield* this.runLoop(systemPrompt, tools, conversation, state, agentRole, extraToolDefs, isTopLevel, maxRounds)
    }

    // Round budget exhausted (and either no confirmContinue was configured,
    // or the user chose to stop rather than continue) — rather than
    // discarding everything gathered so far and returning a bare "ran out
    // of rounds" stub, make one final, tools-disabled call asking the model
    // to synthesize a real answer from what's already in `conversation`.
    // Found live, and worse than it first looked: `state.roundsUsed` used
    // to be shared across the *entire* run, not scoped per delegate call —
    // so once a nested plan-step delegate exhausted the budget,
    // executePlan's own top-level synthesis call (whose whole job is
    // weaving plan-step results into a real final answer) hit the identical
    // exhausted counter and fell through to this same stub too,
    // immediately, without running a single round (fixed separately — see
    // dispatchDelegate's own fresh-budget-per-call comment). The user's
    // real question had already turned up a genuinely relevant, on-topic
    // result (a real news article) sitting untouched in `conversation` when
    // this used to just discard it all. This wrap-up call runs
    // unconditionally here regardless of how far over budget
    // `state.roundsUsed` already is — every call site that hits this path
    // gets exactly one real chance to summarize instead of stub out.
    let wrapUpText = ''
    const wrapUpSystem =
      `${systemPrompt}\n\n${
        outOfTime
          ? "You have used all the time available for this turn — it's taking too long — no"
          : `You have used all ${maxRounds} rounds available for this turn — no`
      } ` +
      'more tool calls are possible. Answer now using only what has already been found above: ' +
      "summarize the real information gathered so far, and say plainly if it's incomplete, rather " +
      'than attempting anything further.'
    // The wrap-up call is exactly the scenario #98 (see refitConversationToBudget) exists for —
    // reached after exhausting rounds/a whole plan, so `conversation` is at its largest for the turn.
    const wrapUpMessages = await this.refitConversationToBudget(
      capRepeatedToolResults(collapseDuplicateToolResults(conversation, toolByName), toolByName),
      toolByName,
      wrapUpSystem,
      [],
      state
    )
    // A one-shot call with no retry of its own, so no escalation applies — same as classifyAndPlan.
    const wrapUpTimer = this.startRoundTimer(state.deadlineAt, 0)
    try {
      for await (const event of this.provider.stream({
        model: this.model,
        system: wrapUpSystem,
        messages: wrapUpMessages,
        maxTokens: state.maxOutputTokens,
        signal: wrapUpTimer.signal
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
      if (!wrapUpTimer.signal.aborted) throw err
      return { text: wrapUpText, isError: true }
    } finally {
      wrapUpTimer.clear()
    }

    if (wrapUpText) {
      yield { kind: 'message', role: 'assistant', content: [{ type: 'text', text: wrapUpText, agentRole }] }
      return { text: wrapUpText, isError: false }
    }

    return {
      text: outOfTime ? 'Stopped — this turn was taking too long.' : `Stopped after ${maxRounds} agent rounds.`,
      isError: true
    }
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

  /**
   * Same abort-race shape as `confirmOrAbort` above, for the same reason —
   * a genuine Stop click while this is pending must resolve it immediately
   * rather than leaving it to the renderer's round trip. Also the single
   * place that applies today's exact unchanged default (no configured
   * `confirmContinue` — the common case for every caller that hasn't opted
   * in, including every existing test) by resolving `continueWorking: false`
   * without ever reaching the renderer at all.
   */
  private askToContinue(request: LimitReachedRequest): Promise<LimitDecision> {
    const confirmContinue = this.options.confirmContinue
    if (!confirmContinue || this.signal.aborted) return Promise.resolve({ continueWorking: false })
    return new Promise((resolve) => {
      const onAbort = (): void => resolve({ continueWorking: false })
      this.signal.addEventListener('abort', onAbort, { once: true })
      confirmContinue(request).then((decision) => {
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
      const content = await this.executeWithTimeout(tool, input)
      return { content, isError: false }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  /**
   * Races `tool.execute` against `this.signal` (Stop) and a flat timeout, so
   * neither can leave the turn waiting forever — see `TOOL_EXECUTE_TIMEOUT_MS`.
   * A loser's rejection is what's thrown. Also builds a dedicated
   * `AbortController` (aborted from either source) and passes its signal
   * into `tool.execute` — flagged by an external code review (`review.md`,
   * TASKS.md #93): the orchestrator's own *wait* was already bounded, but
   * the tool itself never had any way to know it should stop, so a mutating
   * tool (shell command, file write, DB mutation) kept running after Stop or
   * a timeout regardless. A tool that doesn't read `signal` at all (most of
   * them — no cancellable operation to speak of) is unaffected: this is
   * additive, not a behavior change for tools that ignore it, and the
   * message reflects the difference (`tool.cancellable` — see
   * `shellExecuteTool` — vs. every other tool, which honestly says the
   * underlying operation may still be running).
   */
  private executeWithTimeout(tool: Tool, input: Record<string, unknown>): Promise<string> {
    if (this.signal.aborted) return Promise.reject(new Error('The user stopped this turn.'))
    const controller = new AbortController()
    return new Promise((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        controller.abort()
        reject(new Error('The user stopped this turn.'))
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        controller.abort()
        const outcome = tool.cancellable
          ? 'cancelling it so the turn can continue.'
          : 'giving up on this tool call so the turn can continue — it has no way to be cancelled, so the ' +
            'underlying operation may still be running in the background.'
        reject(
          new Error(`"${tool.name}" did not finish within ${Math.round(TOOL_EXECUTE_TIMEOUT_MS / 60000)} minute(s) — ${outcome}`)
        )
      }, TOOL_EXECUTE_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.signal.removeEventListener('abort', onAbort)
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      tool.execute(input, this.toolContext, controller.signal).then(
        (content) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(content)
        },
        (err) => {
          if (settled) return
          settled = true
          cleanup()
          reject(err)
        }
      )
    })
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
    // `isolated` (#77) controls conversation scoping only — this brief alone
    // vs. the whole parent conversation. The round *budget* is always its
    // own fresh pool per delegate call, isolated or not — found live: one
    // shared MAX_TOTAL_ROUNDS pool across the whole turn let a single
    // delegate's real, legitimate work (several file reads, then a
    // multi-step Docker build/debug/fix cycle — nothing looping or wasted)
    // exhaust the budget the rest of the turn still needed, cutting the
    // task off mid-way with the container not yet confirmed working. Every
    // delegate call now gets the same clean slate a role invoked repeatedly
    // per turn (once per slide, say) already relied on for #77, and a
    // compound plan's steps can no longer starve each other or the final
    // synthesis round.
    const nestedConversation: Message[] = agent.isolated ? [taskMessage] : [...conversation, taskMessage]
    const nestedState: RunState = {
      roundsUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      maxOutputTokens: state.maxOutputTokens,
      // Not reset — the fresh round *count* is per-delegate-call, but the
      // wall-clock turn deadline is the whole turn's, shared with every
      // other delegate call in it.
      deadlineAt: state.deadlineAt,
      consecutiveRoundTimeouts: 0
    }
    const maxRounds = agent.maxRounds ?? MAX_TOTAL_ROUNDS

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
      // The round ceiling is its own fresh pool per delegate call, but real
      // token cost never is — roll up into the parent's cumulative totals
      // so session_usage/the context meter still see the true full cost.
      state.inputTokens += nestedState.inputTokens
      state.outputTokens += nestedState.outputTokens
      return { content: result.text || '(no response)', isError: result.isError }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
