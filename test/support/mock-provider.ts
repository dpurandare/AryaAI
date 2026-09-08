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

  constructor(turns: ScriptedTurn[]) {
    this.turns = turns
  }

  async listModels(): Promise<string[]> {
    return ['mock-model']
  }

  async countTokens(): Promise<number> {
    return 0
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request)

    const turn = this.turns[this.nextTurnIndex++]
    if (!turn) {
      throw new Error(
        `MockProvider ran out of scripted turns (received ${this.nextTurnIndex} stream() calls, only ${this.turns.length} scripted).`
      )
    }

    if (turn.text) {
      yield { type: 'text_delta', text: turn.text }
    }

    for (const call of turn.toolCalls ?? []) {
      yield { type: 'tool_use_start', id: call.id, name: call.name }
      yield { type: 'tool_use_delta', id: call.id, partialInput: call.rawInput ?? JSON.stringify(call.input) }
    }

    const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn')
    yield { type: 'message_stop', stopReason }
  }
}
