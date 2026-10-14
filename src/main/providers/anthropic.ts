import Anthropic from '@anthropic-ai/sdk'
import type { CompletionRequest, ContentBlock, Message, ModelProvider, ProviderOptions, StreamEvent } from './types'

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages
    .map((m) => ({
      role: m.role,
      content: m.content
        .map((block): Anthropic.ContentBlockParam | null => {
          if (block.type === 'text') return { type: 'text', text: block.text }
          if (block.type === 'tool_use') {
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
          }
          if (block.type === 'tool_result') {
            return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content, is_error: block.isError }
          }
          return null // 'warning'/'image' — human-facing only, never sent back to the model (see their own doc comments in protocol.ts)
        })
        .filter((b): b is Anthropic.ContentBlockParam => b !== null)
    }))
    .filter((m) => m.content.length > 0)
}

/**
 * The request Anthropic is sent, with **prompt-cache breakpoints** (design-discussion.md 6, step 7). Anthropic's cache is opt-in and keyed on
 * the exact prefix `tools -> system -> messages`, so three `cache_control` markers cover the three things that repeat:
 *  - the last tool (the whole tool list — the biggest, most stable block: ~10K tokens for the full router, ~2K for the slim one),
 *  - the system prompt, and
 *  - the last block of the last message, so each round of a tool loop reuses everything before it and only the new result is processed.
 * Three of the four allowed. A prefix under the model's minimum (1,024 tokens on most models) is silently not cached, which is harmless.
 * Cached reads bill at a fraction of the normal input price; the first write costs a little more — it pays off from the second round.
 * Prefix stability is what makes it work, so nothing in `tools` or `system` may vary between rounds (asserted by a test in
 * orchestrator.test.ts).
 *
 * `promptCaching: false` (Settings > Prompt caching, TASKS #121/#137) sends the plain request with no `cache_control` anywhere and the system prompt as a
 * string — the escape hatch if the API ever rejects the markers, since caching has only been verified against a mocked SDK.
 */
export function buildAnthropicParams(request: CompletionRequest, options: { promptCaching?: boolean; omitTemperature?: boolean } = {}): Anthropic.MessageStreamParams {
  const caching = options.promptCaching !== false
  const cache = { type: 'ephemeral' } as const
  const messages = toAnthropicMessages(request.messages)
  const last = messages.at(-1)
  if (caching && last && Array.isArray(last.content) && last.content.length > 0) {
    const block = last.content[last.content.length - 1] as { type: string; text?: string; cache_control?: unknown }
    // Empty text blocks cannot carry cache_control; every other block type we send (text, tool_use, tool_result) can.
    if (block.type !== 'text' || (block.text ?? '').length > 0) block.cache_control = cache
  }
  // Structured output: Anthropic has no JSON mode, so the schema becomes the input schema of one tool the model is forced to call; `stream()`
  // hands the tool's JSON back as ordinary text. Nothing else repeats between such one-shot calls, so no cache marker on it.
  const forced = request.structuredOutput
  const tools = forced
    ? [
        {
          name: forced.name,
          description: 'Report the result. Call this once with the complete result.',
          input_schema: forced.schema as Anthropic.Tool.InputSchema
        }
      ]
    : request.tools?.map((t, i, all) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        ...(caching && i === all.length - 1 ? { cache_control: cache } : {})
      }))
  return {
    model: request.model,
    system: request.system ? (caching ? [{ type: 'text', text: request.system, cache_control: cache }] : request.system) : undefined,
    max_tokens: request.maxTokens,
    messages,
    tools,
    ...(request.temperature !== undefined && !options.omitTemperature ? { temperature: request.temperature } : {}),
    ...(forced ? { tool_choice: { type: 'tool' as const, name: forced.name } } : {})
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic'
  readonly displayName = 'Anthropic'
  private client: Anthropic

  private promptCaching: boolean

  constructor(apiKey: string, options: ProviderOptions = {}) {
    this.client = new Anthropic({ apiKey })
    this.promptCaching = options.promptCaching !== false
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list()
    return page.data.map((model) => model.id)
  }

  async countTokens(messages: Message[], model: string): Promise<number> {
    const result = await this.client.messages.countTokens({
      model,
      messages: toAnthropicMessages(messages)
    })
    return result.input_tokens
  }

  /** Models whose API rejected `temperature` ("deprecated for this model", found live on claude-haiku-5-5): sent without it from then on. */
  private noTemperature = new Set<string>()

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    let started = false
    try {
      for await (const event of this.streamOnce(request, this.noTemperature.has(request.model))) {
        started = true
        yield event
      }
    } catch (err) {
      const rejected = /temperature/i.test(err instanceof Error ? err.message : String(err)) && (err as { status?: number }).status === 400
      if (started || !rejected || request.temperature === undefined || this.noTemperature.has(request.model)) throw err
      this.noTemperature.add(request.model)
      yield* this.streamOnce(request, true)
    }
  }

  private async *streamOnce(request: CompletionRequest, omitTemperature: boolean): AsyncIterable<StreamEvent> {
    const stream = this.client.messages.stream(
      buildAnthropicParams(request, { promptCaching: this.promptCaching, omitTemperature }),
      { signal: request.signal }
    )

    const activeToolUse = new Map<number, { id: string; name: string }>()
    // Blocks of the forced structured-output tool: their JSON is surfaced as text, and the closing `tool_use` stop as an ordinary end_turn.
    const structuredBlocks = new Set<number>()
    const structuredName = request.structuredOutput?.name
    // Anthropic reports input-token usage once, on `message_start` — `message_delta`
    // (fired later, alongside output usage/stop_reason) never repeats it. Captured here
    // and reused on every `usage` event this round emits, instead of the input side
    // being silently reported as 0.
    let inputTokens = 0
    let cacheReadTokens = 0

    for await (const event of stream) {
      if (event.type === 'message_start') {
        // With prompt caching, `input_tokens` counts only the UNcached part of the input; cache reads and cache writes are reported
        // separately. All three are real input the model saw, so they are summed — otherwise the context meter would under-report
        // the conversation size by almost everything the moment caching starts working. (Cost estimates therefore read as an upper
        // bound for Anthropic: cached input is billed at a fraction of the normal rate, which `estimateCost` does not know.)
        const u = event.message.usage as { input_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
        cacheReadTokens = u.cache_read_input_tokens ?? 0
        inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheReadTokens
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use' && event.content_block.name === structuredName) {
        structuredBlocks.add(event.index)
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        activeToolUse.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name
        })
        yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        } else if (event.delta.type === 'input_json_delta' && structuredBlocks.has(event.index)) {
          yield { type: 'text_delta', text: event.delta.partial_json }
        } else if (event.delta.type === 'input_json_delta') {
          const tool = activeToolUse.get(event.index)
          if (tool) yield { type: 'tool_use_delta', id: tool.id, partialInput: event.delta.partial_json }
        }
      } else if (event.type === 'message_delta') {
        yield {
          type: 'usage',
          inputTokens,
          outputTokens: event.usage.output_tokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {})
        }
        if (event.delta.stop_reason) {
          const stopReason =
            event.delta.stop_reason === 'tool_use' && structuredBlocks.size === 0
              ? 'tool_use'
              : event.delta.stop_reason === 'max_tokens'
                ? 'max_tokens'
                : 'end_turn'
          yield { type: 'message_stop', stopReason }
        }
      }
    }
  }
}

export type { ContentBlock }
