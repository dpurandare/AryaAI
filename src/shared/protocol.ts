/**
 * Domain types shared between the main process (providers, agents) and the
 * renderer (rendering messages/streams). Kept here, not in src/main, so both
 * sides import the same definitions without crossing the process boundary.
 */
import type { AgentRole } from './agents'

export type ContentBlock =
  /** `agentRole` set means a specialist (not the orchestrator itself) produced this block — see main/agents/orchestrator.ts. */
  | { type: 'text'; text: string; agentRole?: AgentRole }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      agentRole?: AgentRole
      /**
       * Opaque per-call signature Gemini requires echoed back on the next
       * turn's functionCall part (400s otherwise, confirmed live) — unused
       * by other providers. See main/providers/google.ts.
       */
      thoughtSignature?: string
    }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export type StreamEvent =
  | { type: 'text_delta'; text: string; agentRole?: AgentRole }
  | { type: 'tool_use_start'; id: string; name: string; agentRole?: AgentRole; thoughtSignature?: string }
  | { type: 'tool_use_delta'; id: string; partialInput: string }
  /** Synthesized by the main process once a tool call finishes running — not emitted by providers. */
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** `agentRole` set means this is a nested specialist's own round ending, not the whole exchange — the renderer must not treat it as final. */
  | {
      type: 'message_stop'
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted'
      agentRole?: AgentRole
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
