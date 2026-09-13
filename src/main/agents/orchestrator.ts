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
   */
  private async *classifyAndPlan(
    conversation: Message[],
    state: RunState
  ): AsyncGenerator<OrchestratorEvent, Plan | undefined> {
    state.roundsUsed++
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    let roundUsage: { inputTokens: number; outputTokens: number } | undefined

    try {
      for await (const event of this.provider.stream({
        model: this.model,
        system: this.buildClassifySystemPrompt(),
        messages: conversation,
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
      // Report it, don't just quietly fall open — the fail-open behavior
      // (proceed as if the request were simple) is still correct, but
      // silently doing so hid exactly the failure mode this whole feature
      // was built to catch (found live: an empty response from hitting the
      // output-token limit, previously indistinguishable from "the model
      // just said nothing needed planning").
      const cause =
        stopReason === 'max_tokens'
          ? 'the classification response was cut off before it could finish (hit the output-token limit)'
          : 'the classification response was not valid JSON'
      const message = `Couldn't tell whether this request is simple or compound (${cause}) — treating it as a normal request instead.`
      yield { kind: 'stream', event: { type: 'warning', message } }
      yield { kind: 'message', role: 'assistant', content: [{ type: 'warning', message }] }
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
      'than one distinct sub-task, build a short ordered plan for it. Respond with ONLY a single JSON ' +
      'object, no markdown fence, no other text:\n' +
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
   */
  private roundStatusMessage(agentRole: AgentRole | undefined, localRound: number): string {
    const activity = localRound === 1 ? 'thinking' : 'reviewing tool results'
    return agentRole ? `${AGENT_ROLE_LABELS[agentRole]} agent is ${activity}…` : `Model (${this.model}) is ${activity}…`
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
    isTopLevel = false
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

    while (state.roundsUsed < MAX_TOTAL_ROUNDS) {
      state.roundsUsed++
      localRound++

      yield {
        kind: 'stream',
        event: tagEvent({ type: 'status', message: this.roundStatusMessage(agentRole, localRound) }, agentRole)
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
          messages: conversation,
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

    return { text: `Stopped after ${MAX_TOTAL_ROUNDS} agent rounds.`, isError: true }
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
        description: tool.describe?.(input) ?? JSON.stringify(input)
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
    const nestedConversation: Message[] = [
      ...conversation,
      {
        role: 'user',
        content: [{ type: 'text', text: `[Orchestrator -> ${AGENT_ROLE_LABELS[role]}]: ${task}` }]
      }
    ]

    try {
      const result = yield* this.runLoop(agent.systemPrompt, agent.tools, nestedConversation, state, role)
      return { content: result.text || '(no response)', isError: result.isError }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
