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
      // Only `tool_result` and `text` are ever mapped for a user-role
      // message — an `image` block (TASKS.md #82) rides alongside a
      // `show_media` call's own `tool_result` in the same message but is
      // never selected here, same as `warning` never was; both are
      // human-facing only (see their own doc comments in protocol.ts).
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
      ...(request.structuredOutput
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: { name: request.structuredOutput.name, strict: true, schema: request.structuredOutput.schema }
            }
          }
        : {}),
      stream: true,
      stream_options: { include_usage: true }
    },
    { signal: request.signal }
  )

  const toolCalls = new Map<number, { id: string; name: string }>()
  let sawMessageStop = false

  for await (const chunk of stream) {
    const choice = chunk.choices[0]

    if (choice?.delta?.content) {
      yield { type: 'text_delta', text: choice.delta.content }
    }

    // TASKS.md #147: Ollama and Groq stream real reasoning content on this shared OpenAI-compatible path,
    // but under different field names (not in the official OpenAI Chat Completions type, hence the cast) —
    // `reasoning` and `reasoning_content` are both real, observed field names across OpenAI-compatible-
    // shaped providers, so both are checked rather than picking one and silently missing the other.
    const reasoning = (choice?.delta as { reasoning?: string; reasoning_content?: string } | undefined)?.reasoning
    const reasoningContent = (choice?.delta as { reasoning?: string; reasoning_content?: string } | undefined)?.reasoning_content
    const thinkingText = reasoning || reasoningContent
    if (thinkingText) {
      yield { type: 'thinking_delta', text: thinkingText }
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
      // OpenAI (and providers that copy its shape) cache a byte-stable prefix automatically and report the cached part here. `prompt_tokens`
      // already includes it, so `inputTokens` is unchanged; the cached share is surfaced so caching can be measured (step 7).
      const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? 0
      yield {
        type: 'usage',
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        ...(cached > 0 ? { cacheReadTokens: cached } : {})
      }
    }

    if (choice?.finish_reason) {
      const stopReason =
        choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn'
      sawMessageStop = true
      yield { type: 'message_stop', stopReason }
    }
  }

  // Found live against Ollama/gpt-oss: the underlying HTTP stream can end
  // (server closes the connection — a crashed/unloaded model, a truncated
  // response, or just a quirk of Ollama's OpenAI-compat layer) without ever
  // sending a chunk that carries `finish_reason`. Every consumer of this
  // generator (runLoop, classifyAndPlan) relies on eventually seeing a
  // `message_stop` to know the round is over — the *renderer* specifically
  // only clears its "Thinking…" state on that event (or an `error` one).
  // Without this fallback, a stream that ends silently like this leaves the
  // whole turn stuck forever with no error, nothing left running to
  // Stop/cancel, and no way to recover short of reloading the window —
  // confirmed live via a real hang with zero pending promises and zero
  // network activity, i.e. the process had already finished, it just never
  // said so.
  if (!sawMessageStop) {
    yield { type: 'message_stop', stopReason: 'end_turn' }
  }
}
