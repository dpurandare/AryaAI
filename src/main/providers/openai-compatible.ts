import OpenAI from 'openai'
import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'
import type { CompletionRequest, Message, StreamEvent } from './types'

let encoder: Tiktoken | undefined
function getEncoder(): Tiktoken {
  encoder ??= new Tiktoken(o200k_base)
  return encoder
}

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
      // A warning-only (or otherwise empty) assistant message has neither
      // real text nor a tool call — sending {content: null, tool_calls:
      // undefined} produced a real 400 from Ollama's OpenAI-compat layer
      // ("invalid message content type"), confirmed live. A warning is a
      // human-facing notice, never something the model itself said —
      // reflecting it back as an empty assistant turn was always wrong,
      // not just wire-format-invalid; omit the message entirely.
      if (!text && toolCalls.length === 0) continue
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

/**
 * Approximate token count via tiktoken's o200k_base encoding (the current
 * GPT-4o/5-family tokenizer) — OpenAI exposes no counting endpoint, so a
 * tiktoken-based estimate is the standard approach. For Ollama specifically
 * this is an approximation of an approximation, since local models use
 * their own tokenizers — still far better than a hardcoded 0.
 */
export function countTokensApprox(system: string | undefined, messages: Message[]): number {
  const params = toOpenAIMessages(system, messages)
  const text = params.map((p) => JSON.stringify(p)).join('\n')
  return getEncoder().encode(text).length
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
