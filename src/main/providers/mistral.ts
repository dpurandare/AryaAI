import OpenAI from 'openai'
import { countTokensApprox, streamOpenAICompatible } from './openai-compatible'
import type { CompletionRequest, EmbeddingProvider, Message, ModelProvider, StreamEvent } from './types'

/**
 * Mistral's `/v1/*` endpoints are OpenAI Chat Completions-wire-compatible —
 * confirmed against Mistral's own current docs (docs.mistral.ai/api,
 * .../api/endpoint/chat, .../resources/migration-guides), not assumed: base
 * URL `https://api.mistral.ai/v1`, a standard Bearer API key, and the
 * migration guide states plainly "The Mistral Chat Completions API follows
 * the same request structure as OpenAI" and can be used by "pointing [an
 * OpenAI-compatible client] at the Mistral API by changing only the base URL
 * and model name" — no library replacement required. Same pattern as the
 * Ollama/Groq adapters: point the `openai` SDK at a different base URL
 * rather than Mistral's own native SDK, whose higher-level streaming
 * wrapper (`client.chat.stream()`) has a different, non-OpenAI-shaped event
 * model — deliberately bypassed by talking the raw wire protocol directly,
 * which Mistral documents as OpenAI-request-structure-compatible.
 *
 * Genuinely NOT yet live-verified against a real account (unlike Ollama's
 * confirmed-live compatibility) — Mistral's own docs didn't expose the exact
 * streamed tool_calls delta shape at implementation time, only that the
 * request/response structure "follows the same request structure as
 * OpenAI." Flagged for live verification once a real API key is available;
 * see TASKS.md.
 *
 * Unlike Groq, Mistral genuinely has a `/v1/embeddings` endpoint
 * (`mistral-embed`, confirmed: request `{model, input}`, response
 * `{data: [{embedding, index, object}], ...}` — the same shape
 * OpenAI/Ollama's embeddings.create() already handles), so this does
 * implement `EmbeddingProvider`.
 */
export class MistralProvider implements ModelProvider, EmbeddingProvider {
  readonly id = 'mistral'
  readonly displayName = 'Mistral'
  private client: OpenAI
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.mistral.ai/v1' })
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list()
    return page.data.map((model) => model.id)
  }

  async countTokens(messages: Message[]): Promise<number> {
    // An approximation of an approximation, same caveat as Ollama/Groq's —
    // Mistral's models use their own tokenizer, not OpenAI's — but still
    // far better than a hardcoded 0.
    return countTokensApprox(undefined, messages)
  }

  stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    return streamOpenAICompatible(this.client, request)
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const response = await this.client.embeddings.create({ model, input: texts })
    return response.data.map((item) => item.embedding)
  }

  /**
   * A real, provider-reported number rather than a hand-maintained guess —
   * confirmed via Mistral's own `GET /v1/models` docs: each entry includes
   * a real `max_context_length` field, unlike OpenAI's/Groq's equivalent
   * listing (`openai`'s SDK type has no such field, so this bypasses it
   * with a raw `fetch`, same reasoning as Ollama's `/api/ps`/`/api/show`
   * calls). Named `loadedContextWindow` (not `configuredContextWindow`)
   * specifically so `orchestrator.ts`'s `resolveMaxOutputTokens` — which
   * only ever reads `loadedContextWindow`, not `configuredContextWindow` —
   * benefits from the real number too, not just `prepare-context.ts`'s
   * input-side trim (which reads both). Mistral has no load/unload
   * distinction the way a local Ollama model does; "loaded" here just means
   * "the model's real, currently-served context length," which is always
   * true for a cloud model. Returns `undefined` (falls back to
   * model-metadata.ts's generic cloud estimate) on any failure or an
   * unrecognized model id, same as every other optional live-reading method
   * in this codebase.
   */
  async loadedContextWindow(model: string): Promise<number | undefined> {
    try {
      const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      })
      if (!res.ok) return undefined
      const data = (await res.json()) as { data?: { id: string; max_context_length?: number }[] }
      return data.data?.find((m) => m.id === model)?.max_context_length
    } catch {
      return undefined
    }
  }
}
