import type {
  CompletionRequest,
  Message,
  ModelProvider,
  StreamEvent
} from '../../src/main/providers/types'

export interface ScriptedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  /** Overrides `input` as the literal streamed partialInput — for exercising malformed-JSON handling. */
  rawInput?: string
}

export interface ScriptedTurn {
  text?: string
  toolCalls?: ScriptedToolCall[]
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
  /** Yielded twice in a row before message_stop, matching real providers (Anthropic, Gemini) that repeat a cumulative usage total across chunks rather than sending it once — see orchestrator.ts's roundUsage handling. */
  usage?: { inputTokens: number; outputTokens: number }
  /** Throws instead of streaming anything — every real SDK throws its own differently-shaped error when the request's AbortSignal fires mid-call; the orchestrator is expected to tell that apart from a genuine failure via `request.signal.aborted`, not by inspecting the error itself. */
  throwError?: string
  /**
   * Simulates a round that never produces anything on its own — the stream
   * just never resolves until `request.signal` fires (a round-timeout or a
   * real user Stop), then **throws** an AbortError-shaped error. Matches
   * Anthropic's and Google's SDKs (confirmed live). Does NOT match the
   * `openai` SDK (used for both OpenAI and Ollama) — see `hangSilently`.
   */
  hang?: boolean
  /**
   * Simulates the same "never produces anything until aborted" shape as
   * `hang`, but ends the stream **silently instead of throwing** — the
   * `openai` SDK's actual behavior when a stalled request's AbortSignal
   * fires, confirmed both by reading its source (`core/streaming.mjs`
   * catches the abort internally and `return`s rather than rethrowing) and
   * by a direct reproduction against a real HTTP server. Found live: this
   * distinction is exactly why the orchestrator's round-timeout retry
   * silently never fired against a real stalled Ollama connection, despite
   * passing every test written against `hang`'s throwing shape — the
   * silent end looked identical to a genuine empty response instead of a
   * timeout. Yields a bare `message_stop` (`end_turn`) once aborted, the
   * same synthetic event `streamOpenAICompatible`'s own end-of-stream
   * fallback produces for this exact case.
   */
  hangSilently?: boolean
}

export interface MockProviderOptions {
  /** When set, the mock implements `loadedContextWindow` returning this value — exercises Orchestrator.resolveMaxOutputTokens's scaled path. Omitted (the default) means no `loadedContextWindow` method at all, matching every cloud-provider adapter and exercising the unchanged flat-4096 fallback path every existing test relies on. */
  loadedContextWindow?: number
  /** `countTokens()`'s return value — defaults to 0, preserving every existing test's behavior. */
  tokensUsed?: number
}

/**
 * A ModelProvider driven by a scripted, ordered list of turns instead of a
 * real API. Orchestrator.run() calls provider.stream() exactly once per
 * round, at every nesting level, reusing the same provider instance for the
 * outer loop and every delegated specialist — so a FIFO queue consumed one
 * turn per .stream() call lines up with a multi-round delegation exactly
 * the way the real thing would.
 */
export class MockProvider implements ModelProvider {
  readonly id = 'mock'
  readonly displayName = 'Mock'

  /** Every CompletionRequest received, in order — for asserting what was actually sent. */
  readonly requests: CompletionRequest[] = []
  /** Every `countTokens` call's own `messages` arg, in order — e.g. for asserting `resolveMaxOutputTokens`'s overhead call (TASKS.md #97) actually ran with the real system-prompt/tool-schema text, not just the conversation. */
  readonly countTokensCalls: Message[][] = []

  private readonly turns: ScriptedTurn[]
  private nextTurnIndex = 0
  private readonly tokensUsed: number
  /**
   * A value here vs. `undefined` here behaves identically to the calling
   * code's `provider.loadedContextWindow?.(model)` as a real cloud provider
   * adapter not implementing the method at all — optional chaining short-
   * circuits on either shape. Simpler than conditionally defining/omitting
   * the method itself, with no class-field-initializer-ordering risk.
   */
  readonly loadedContextWindow?: (model: string) => Promise<number | undefined>

  constructor(turns: ScriptedTurn[], options: MockProviderOptions = {}) {
    this.turns = turns
    this.tokensUsed = options.tokensUsed ?? 0
    const contextWindow = options.loadedContextWindow
    this.loadedContextWindow = contextWindow === undefined ? undefined : async () => contextWindow
  }

  async listModels(): Promise<string[]> {
    return ['mock-model']
  }

  async countTokens(messages: Message[]): Promise<number> {
    this.countTokensCalls.push(messages)
    return this.tokensUsed
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request)

    const turn = this.turns[this.nextTurnIndex++]
    if (!turn) {
      throw new Error(
        `MockProvider ran out of scripted turns (received ${this.nextTurnIndex} stream() calls, only ${this.turns.length} scripted).`
      )
    }

    if (turn.throwError) {
      throw new Error(turn.throwError)
    }

    if (turn.hang) {
      await new Promise<never>((_resolve, reject) => {
        const signal = request.signal
        if (!signal) return // no signal means this really would hang forever — a test bug, not simulated behavior
        if (signal.aborted) {
          reject(new Error('The operation was aborted'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true })
      })
    }

    if (turn.hangSilently) {
      await new Promise<void>((resolve) => {
        const signal = request.signal
        if (!signal) return // no signal means this really would hang forever — a test bug, not simulated behavior
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'message_stop', stopReason: 'end_turn' }
      return
    }

    if (turn.text) {
      yield { type: 'text_delta', text: turn.text }
    }

    for (const call of turn.toolCalls ?? []) {
      yield { type: 'tool_use_start', id: call.id, name: call.name }
      yield { type: 'tool_use_delta', id: call.id, partialInput: call.rawInput ?? JSON.stringify(call.input) }
    }

    if (turn.usage) {
      yield { type: 'usage', ...turn.usage }
      yield { type: 'usage', ...turn.usage }
    }

    const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn')
    yield { type: 'message_stop', stopReason }
  }
}
