import type {
  CompletionRequest,
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

  async countTokens(): Promise<number> {
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
