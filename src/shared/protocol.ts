/**
 * Domain types shared between the main process (providers, agents) and the
 * renderer (rendering messages/streams). Kept here, not in src/main, so both
 * sides import the same definitions without crossing the process boundary.
 */
import type { AgentRole } from './agents'

export type ContentBlock =
  /** `agentRole` set means a specialist (not the orchestrator itself) produced this block — see main/agents/orchestrator.ts. */
  | { type: 'text'; text: string; agentRole?: AgentRole }
  /**
   * TASKS.md #147: the model's own real reasoning/chain-of-thought, when the provider streams it as a
   * distinct signal — Ollama/Groq (`delta.reasoning`/`delta.reasoning_content`, whichever a given
   * OpenAI-compatible-shaped provider uses) and Gemini (`part.thought`, opt-in via `thinkingConfig.
   * includeThoughts`). Persisted like `text` so it survives a reload; the renderer collapses it by
   * default, reusing #72/#88's existing tool-output collapse toggle rather than a new convention.
   * OpenAI/Anthropic are explicitly out of scope here — OpenAI's reasoning models don't stream raw CoT via
   * the Chat Completions API this app uses (policy-level), and Anthropic extended thinking is tracked
   * separately as #159 (needs its own request-shape opt-in and redacted-thinking-block replay rules).
   */
  | { type: 'thinking'; text: string; agentRole?: AgentRole }
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
   * TASKS.md #158: a user comment injected mid-run, between rounds — the user spotted the model heading
   * down a wrong path and dropped in a correction without waiting for the whole turn or hitting Stop. A
   * distinct type purely for turn-boundary and UI-rendering purposes: the MODEL sees it as ordinary text
   * (`normalizeUserNotesForWire`, context/prepare-context.ts, converts it right before the request is sent),
   * and it never starts a new turn boundary the way an ordinary `role: 'user'` message would (`splitIntoTurns`,
   * same file, treats a message made only of these — like `tool_result`/`image` — as a continuation of the
   * turn already running) — inserting it as a plain `text` block would have fractured `search_history`'s
   * embedding (#52) and every turn-scoped mechanism (the sliding window, #149's own per-turn cap) into
   * thinking a second, unrelated top-level request had started mid-turn.
   */
  | { type: 'user_note'; text: string }
  /**
   * A non-fatal problem worth surfacing rather than silently absorbing —
   * e.g. a round truncated by hitting its output-token limit before
   * finishing, or the classify-and-plan pass failing to produce a usable
   * plan. The turn still completes (this isn't `tool_result`'s `isError`,
   * which fails one specific call); this just tells the user something
   * degraded rather than pretending the result is complete/normal.
   * Persisted like `text`/`tool_use` so it survives a session reload.
   */
  | {
      type: 'warning'
      message: string
      agentRole?: AgentRole
      /**
       * Set only when this warning represents the *entire turn* producing no
       * real answer at all — TASKS.md #102, found live: a thrown provider
       * error, a Stop click before anything was produced, or an empty/no-
       * output round all used to leave either nothing persisted or a bare
       * warning, and the user's original question kept getting silently
       * resent as unanswered "real" context on every later call, forever
       * (confirmed live: 4 identical retries in a row each resending the
       * whole growing, still-unanswered history). `prepare-context.ts`'s
       * `removeFailedTurns` strips a whole turn tagged with this from what's
       * sent to the model on every *subsequent* call — never from what's
       * persisted/shown, same "only affects what's sent" convention as
       * every other trimming pass in this codebase. Left `undefined` for
       * every purely informational warning (a context-trim notice, a deck-
       * autosave notice, a plan-truncation notice, a partial/cut-off
       * response that still has real usable content) — those still count as
       * legitimate history and are never stripped by this mechanism.
       */
      failureCategory?: 'communication_failure' | 'stopped_by_user' | 'no_answer'
    }
  /**
   * TASKS.md #82 — a `show_media` tool call's actual payload, split out
   * into its own block rather than living in `tool_result`'s `content`
   * string: the base64 bytes must never be sent back to the model (every
   * provider's own wire-format mapping drops an `image` block entirely,
   * the same convention `warning` already uses) — a display-only feature
   * has no reason to spend real tokens re-sending the encoded image on
   * every later request. `toolUseId` links it back to the `show_media`
   * call that produced it, same as `tool_result`. Scope settled deliberately
   * narrow for a first pass (see `tools/show-media.ts`'s own doc comment):
   * images only, inline base64 (not a served URL) — video is a separate,
   * later item once this mechanism is proven.
   */
  | { type: 'image'; toolUseId: string; path: string; mimeType: string; dataBase64: string; agentRole?: AgentRole }

export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export type StreamEvent =
  | { type: 'text_delta'; text: string; agentRole?: AgentRole }
  /** Live counterpart of `ContentBlock`'s `thinking` — see its own doc comment (TASKS.md #147). Providers emit this incrementally, same as `text_delta`. */
  | { type: 'thinking_delta'; text: string; agentRole?: AgentRole }
  | { type: 'tool_use_start'; id: string; name: string; agentRole?: AgentRole; thoughtSignature?: string }
  | { type: 'tool_use_delta'; id: string; partialInput: string }
  /** Synthesized by the main process once a tool call finishes running — not emitted by providers. */
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** Live counterpart of `ContentBlock`'s `image` — see its own doc comment. Streamed once, alongside the `show_media` call's own `tool_result`. */
  | { type: 'image'; toolUseId: string; path: string; mimeType: string; dataBase64: string; agentRole?: AgentRole }
  /** Live counterpart of `ContentBlock`'s `user_note` — see its own doc comment (TASKS.md #158). Streamed once, alongside the matching persisted message. */
  | { type: 'user_note'; text: string }
  /** `agentRole` set means this is a nested specialist's own round ending, not the whole exchange — the renderer must not treat it as final. */
  | {
      type: 'message_stop'
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted'
      agentRole?: AgentRole
    }
  /** `cacheReadTokens` (Anthropic prompt caching): the part of `inputTokens` served from the cache; present only when non-zero. */
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
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
  /** Live counterpart of `ContentBlock`'s `warning` — see its doc comment, including `failureCategory`. Streamed immediately and also included in the `kind: 'message'` event that gets persisted, exactly like `tool_use`/`text`. */
  | { type: 'warning'; message: string; agentRole?: AgentRole; failureCategory?: 'communication_failure' | 'stopped_by_user' | 'no_answer' }
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
