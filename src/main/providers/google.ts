import { randomUUID } from 'node:crypto'
import { FinishReason, FunctionCallingConfigMode, GoogleGenAI } from '@google/genai'
import type { Content, Part } from '@google/genai'
import type { CompletionRequest, EmbeddingProvider, Message, ModelProvider, StreamEvent } from './types'

/**
 * Gemini has no separate "tool" role — a tool result is a `functionResponse`
 * part on a user-role message, and a tool call is a `functionCall` part on a
 * model-role message (same shape as how Anthropic nests tool_result in user
 * messages). `functionResponse` needs the original call's `name`, which our
 * ContentBlock doesn't carry on the result — tracked here as we walk in
 * order, since the call always precedes its result in the conversation.
 */
function toGeminiContents(messages: Message[]): Content[] {
  const toolNames = new Map<string, string>()

  return messages.map((m) => {
    const parts: Part[] = m.content.map((block) => {
      if (block.type === 'text') return { text: block.text }
      if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name)
        return {
          functionCall: { id: block.id, name: block.name, args: block.input },
          // Required by Gemini on the next turn's functionCall part, or it
          // 400s ("Function call is missing a thought_signature") — confirmed
          // live. See https://ai.google.dev/gemini-api/docs/thought-signatures.
          thoughtSignature: block.thoughtSignature
        }
      }
      return {
        functionResponse: {
          id: block.toolUseId,
          name: toolNames.get(block.toolUseId) ?? '',
          response: block.isError ? { error: block.content } : { output: block.content }
        }
      }
    })
    return { role: m.role === 'assistant' ? 'model' : 'user', parts }
  })
}

export class GoogleProvider implements ModelProvider, EmbeddingProvider {
  readonly id = 'google'
  readonly displayName = 'Google (Gemini)'
  private client: GoogleGenAI

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async listModels(): Promise<string[]> {
    const models: string[] = []
    for await (const model of await this.client.models.list()) {
      if (model.name) models.push(model.name.replace(/^models\//, ''))
    }
    return models
  }

  async countTokens(messages: Message[], model: string): Promise<number> {
    const result = await this.client.models.countTokens({
      model,
      contents: toGeminiContents(messages)
    })
    return result.totalTokens ?? 0
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const response = await this.client.models.embedContent({ model, contents: texts })
    return (response.embeddings ?? []).map((embedding) => embedding.values ?? [])
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.client.models.generateContentStream({
      model: request.model,
      contents: toGeminiContents(request.messages),
      config: {
        systemInstruction: request.system,
        maxOutputTokens: request.maxTokens,
        abortSignal: request.signal,
        tools: request.tools?.length
          ? [
              {
                functionDeclarations: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.inputSchema
                }))
              }
            ]
          : undefined,
        toolConfig: request.tools?.length
          ? { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
          : undefined
      }
    })

    // The function call and the chunk carrying `finishReason` are not
    // necessarily the same chunk (confirmed live: Gemini emits the call in
    // one chunk and STOP in a later, function-call-free chunk) — track
    // whether any chunk in this stream had a call, not just the current one.
    let sawFunctionCall = false

    for await (const chunk of response) {
      // Read parts directly rather than the `.text`/`.functionCalls`
      // convenience getters — those log a console warning whenever a chunk
      // mixes a functionCall part with non-text parts, which is the normal
      // case for every tool call (confirmed live, harmless but noisy).
      const parts = chunk.candidates?.[0]?.content?.parts ?? []

      for (const part of parts) {
        if (part.text) {
          yield { type: 'text_delta', text: part.text }
        }
        // Gemini returns each call's full args in one shot, not incremental
        // JSON deltas — so a single tool_use_delta carries the whole payload.
        if (part.functionCall) {
          sawFunctionCall = true
          const id = part.functionCall.id ?? randomUUID()
          yield {
            type: 'tool_use_start',
            id,
            name: part.functionCall.name ?? '',
            thoughtSignature: part.thoughtSignature
          }
          yield { type: 'tool_use_delta', id, partialInput: JSON.stringify(part.functionCall.args ?? {}) }
        }
      }

      if (chunk.usageMetadata) {
        yield {
          type: 'usage',
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0
        }
      }

      const finishReason = chunk.candidates?.[0]?.finishReason
      if (finishReason) {
        const stopReason = sawFunctionCall
          ? 'tool_use'
          : finishReason === FinishReason.MAX_TOKENS
            ? 'max_tokens'
            : 'end_turn'
        yield { type: 'message_stop', stopReason }
      }
    }
  }
}
