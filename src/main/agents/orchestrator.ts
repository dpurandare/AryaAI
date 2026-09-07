import type { ContentBlock, Message, StreamEvent } from '@shared/protocol'
import type { AgentRole } from '@shared/agents'
import { AGENT_ROLE_LABELS } from '@shared/agents'
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

function tagEvent(event: StreamEvent, agentRole: AgentRole | undefined): StreamEvent {
  if (!agentRole) return event
  if (event.type === 'text_delta') return { ...event, agentRole }
  if (event.type === 'tool_use_start') return { ...event, agentRole }
  // A nested specialist's own message_stop must be distinguishable from the top-level
  // exchange truly ending, or the renderer can't tell them apart and stops listening
  // early — found live: a delegated call's own tool_result and the orchestrator's real
  // final reply were both silently dropped because the specialist's own end_turn looked
  // identical to the whole conversation's end_turn.
  if (event.type === 'message_stop') return { ...event, agentRole }
  return event
}

interface AccumulatedToolCall {
  id: string
  name: string
  inputJson: string
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
    private readonly toolContext: ToolContext
  ) {}

  /**
   * Runs one user turn. If `forcedRole` is set (manual override — see
   * TASKS.md orchestrator plan), skips the orchestrator's own routing
   * entirely and runs that specialist directly, with no delegate tools of
   * its own available.
   */
  async *run(conversation: Message[], forcedRole?: AgentRole | null): AsyncIterable<OrchestratorEvent> {
    const budget = { used: 0 }

    if (forcedRole) {
      const agent = this.agents.get(forcedRole)
      if (!agent) throw new Error(`Unknown agent role "${forcedRole}".`)
      yield* this.runLoop(agent.systemPrompt, agent.tools, conversation, budget, forcedRole)
      return
    }

    yield* this.runLoop(
      this.buildOrchestratorSystemPrompt(),
      this.defaultTools,
      conversation,
      budget,
      undefined,
      this.buildDelegateToolDefinitions()
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
    budget: { used: number },
    agentRole: AgentRole | undefined,
    extraToolDefs: ToolDefinition[] = []
  ): AsyncGenerator<OrchestratorEvent, { text: string; isError: boolean }> {
    const toolByName = new Map(tools.map((t) => [t.name, t]))
    const toolDefs: ToolDefinition[] = [
      ...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...extraToolDefs
    ]

    while (budget.used < MAX_TOTAL_ROUNDS) {
      budget.used++

      let assistantText = ''
      const toolCalls: AccumulatedToolCall[] = []
      const toolCallsById = new Map<string, AccumulatedToolCall>()
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'

      for await (const event of this.provider.stream({
        model: this.model,
        system: systemPrompt,
        messages: conversation,
        maxTokens: 4096,
        tools: toolDefs.length ? toolDefs : undefined
      })) {
        if (event.type === 'text_delta') {
          assistantText += event.text
        } else if (event.type === 'tool_use_start') {
          const call: AccumulatedToolCall = { id: event.id, name: event.name, inputJson: '' }
          toolCalls.push(call)
          toolCallsById.set(event.id, call)
        } else if (event.type === 'tool_use_delta') {
          const call = toolCallsById.get(event.id)
          if (call) call.inputJson += event.partialInput
        } else if (event.type === 'message_stop') {
          stopReason = event.stopReason
        }
        yield { kind: 'stream', event: tagEvent(event, agentRole) }
      }

      const assistantBlocks: ContentBlock[] = []
      if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText, agentRole })
      const inputByCallId = new Map<string, Record<string, unknown>>()
      for (const call of toolCalls) {
        let input: Record<string, unknown> = {}
        try {
          input = call.inputJson ? JSON.parse(call.inputJson) : {}
        } catch {
          // Malformed tool input is surfaced back to the model as an error result below.
        }
        inputByCallId.set(call.id, input)
        assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input, agentRole })
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
        return { text: assistantText, isError: false }
      }

      const resultBlocks: ContentBlock[] = []
      for (const call of toolCalls) {
        const input = inputByCallId.get(call.id) ?? {}
        const delegateRole = roleFromDelegateName(call.name, this.agents)

        let content: string
        let isError: boolean
        if (delegateRole) {
          const result = yield* this.dispatchDelegate(delegateRole, input, conversationBeforeThisRound, budget)
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

    if (tool.mutates) {
      const decision = await this.confirmTool({
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
    budget: { used: number }
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
      const result = yield* this.runLoop(agent.systemPrompt, agent.tools, nestedConversation, budget, role)
      return { content: result.text || '(no response)', isError: result.isError }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
