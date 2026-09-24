import Anthropic from '@anthropic-ai/sdk'
import type { CompletionRequest, ContentBlock, Message, ModelProvider, StreamEvent } from './types'

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

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic'
  readonly displayName = 'Anthropic'
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
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

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const stream = this.client.messages.stream(
      {
        model: request.model,
        system: request.system,
        max_tokens: request.maxTokens,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema
        }))
      },
      { signal: request.signal }
    )

    const activeToolUse = new Map<number, { id: string; name: string }>()
    // Anthropic reports input-token usage once, on `message_start` — `message_delta`
    // (fired later, alongside output usage/stop_reason) never repeats it. Captured here
    // and reused on every `usage` event this round emits, instead of the input side
    // being silently reported as 0.
    let inputTokens = 0

    for await (const event of stream) {
      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        activeToolUse.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name
        })
        yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          const tool = activeToolUse.get(event.index)
          if (tool) yield { type: 'tool_use_delta', id: tool.id, partialInput: event.delta.partial_json }
        }
      } else if (event.type === 'message_delta') {
        yield {
          type: 'usage',
          inputTokens,
          outputTokens: event.usage.output_tokens
        }
        if (event.delta.stop_reason) {
          const stopReason =
            event.delta.stop_reason === 'tool_use'
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
