import type { ModelProvider, Message } from '../providers/types'
import type { Tool } from '../tools/types'

export type AgentRole =
  | 'planning'
  | 'research'
  | 'coding'
  | 'terminal-devops'
  | 'data'
  | 'distribution'

export interface Agent {
  role: AgentRole
  systemPrompt: string
  tools: Tool[]
}

/**
 * The Orchestrator owns the conversation: it picks which specialized Agent
 * handles the current step, runs it to completion (sequential handoff, no
 * concurrent agents in v1), and feeds the result back into the conversation.
 */
export class Orchestrator {
  constructor(
    private readonly provider: ModelProvider,
    private readonly agents: Map<AgentRole, Agent>
  ) {}

  // TODO: implement step-by-step delegation:
  //  1. Ask the model (with a routing-oriented system prompt) which agent role
  //     should handle the next step, given the conversation so far.
  //  2. Run that Agent's system prompt + tools via provider.stream().
  //  3. Append the result to the conversation and repeat until end_turn.
  async *run(_conversation: Message[]): AsyncIterable<never> {
    void this.provider
    void this.agents
    throw new Error('Orchestrator.run not yet implemented')
  }
}
