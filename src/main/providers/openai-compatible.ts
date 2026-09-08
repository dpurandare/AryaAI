import OpenAI from 'openai'
import type { CompletionRequest, Message, StreamEvent } from './types'

/**
 * Message/stream translation shared by every provider that speaks the OpenAI
 * Chat Completions wire format — currently OpenAI itself and Ollama (its
 * `/v1/chat/completions` endpoint is wire-compatible, confirmed live
 * including real tool-call responses).
 */
export function toOpenAIMessages(
  system: string | undefined,
  messages: Message[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (system) result.push({ role: 'system', content: system })

  for (const m of messages) {
    if (m.role === 'user') {
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          result.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
        }
      }
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text) result.push({ role: 'user', content: text })
    } else {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const toolCalls = m.content.filter((b) => b.type === 'tool_use')
      result.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.length
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) }
            }))
          : undefined
      })
    }
  }
  return result
}

export async function* streamOpenAICompatible(
  client: OpenAI,
  request: CompletionRequest
): AsyncIterable<StreamEvent> {
  const stream = await client.chat.completions.create(
    {
      model: request.model,
      messages: toOpenAIMessages(request.system, request.messages),
      max_completion_tokens: request.maxTokens,
      tools: request.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      })),
      stream: true,
      stream_options: { include_usage: true }
    },
    { signal: request.signal }
  )

  const toolCalls = new Map<number, { id: string; name: string }>()

  for await (const chunk of stream) {
    const choice = chunk.choices[0]

    if (choice?.delta?.content) {
      yield { type: 'text_delta', text: choice.delta.content }
    }

    for (const call of choice?.delta?.tool_calls ?? []) {
      if (call.id && call.function?.name) {
        toolCalls.set(call.index, { id: call.id, name: call.function.name })
        yield { type: 'tool_use_start', id: call.id, name: call.function.name }
      }
      if (call.function?.arguments) {
        const known = toolCalls.get(call.index)
        if (known) {
          yield { type: 'tool_use_delta', id: known.id, partialInput: call.function.arguments }
        }
      }
    }

    if (chunk.usage) {
      yield {
        type: 'usage',
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens
      }
    }

    if (choice?.finish_reason) {
      const stopReason =
        choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn'
      yield { type: 'message_stop', stopReason }
    }
  }
}
