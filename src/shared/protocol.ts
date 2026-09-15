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
  /**
   * A non-fatal problem worth surfacing rather than silently absorbing —
   * e.g. a round truncated by hitting its output-token limit before
   * finishing, or the classify-and-plan pass failing to produce a usable
   * plan. The turn still completes (this isn't `tool_result`'s `isError`,
   * which fails one specific call); this just tells the user something
   * degraded rather than pretending the result is complete/normal.
   * Persisted like `text`/`tool_use` so it survives a session reload.
   */
  | { type: 'warning'; message: string; agentRole?: AgentRole }

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
  /**
   * Emitted once per user turn (not per round), right after context prep
   * resolves the model's real context window for this turn — see
   * `context/prepare-context.ts`'s `resolveContextWindow`. `isEstimate`
   * false means a confirmed real number (a live Ollama `/api/ps` reading,
   * or a matched static entry for a recognized cloud model); true means
   * there was nothing better than a conservative guess (a cold/unrecognized
   * local model, or an unrecognized cloud model id). Lets the renderer's
   * context meter use the real figure instead of its own static guess,
   * which — for a local model especially — can differ hugely from what's
   * actually loaded (confirmed live: a 128K-capable custom Modelfile still
   * showed a hardcoded 4096-token fallback before this existed).
   */
  | { type: 'context_window'; tokens: number; isEstimate: boolean }
  | { type: 'error'; message: string }
  /** Live counterpart of `ContentBlock`'s `warning` — see its doc comment. Streamed immediately and also included in the `kind: 'message'` event that gets persisted, exactly like `tool_use`/`text`. */
  | { type: 'warning'; message: string; agentRole?: AgentRole }
  /**
   * A human-readable "what's happening right now" hint, sent once per round
   * right before the provider call that produces it — not persisted, purely
   * a live UI signal (see orchestrator.ts's `runLoop`). `agentRole` set
   * means it describes a nested specialist's own round, same convention as
   * every other tagged event here.
   */
  | { type: 'status'; message: string; agentRole?: AgentRole }
  /**
   * Emitted once, only for a request the classify-and-plan pass judged
   * compound (see orchestrator.ts's `classifyAndPlan`) — carries the full
   * step list up front so the UI can render a live checklist. Not
   * persisted: the step *results* already land as ordinary persisted
   * messages via each step's own delegate/runLoop call, exactly like
   * today's delegation — this is a progress overlay, not a second source
   * of truth for what was actually said.
   */
  | { type: 'plan'; steps: { role: AgentRole; description: string }[] }
  /** Marks one plan step (by its index into the `plan` event's `steps`) as having started/finished, for the checklist above. */
  | { type: 'plan_step_start'; index: number }
  | { type: 'plan_step_done'; index: number; isError: boolean }
