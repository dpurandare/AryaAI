import OpenAI from 'openai'
import { countTokensApprox, streamOpenAICompatible } from './openai-compatible'
import type { CompletionRequest, EmbeddingProvider, Message, ModelProvider, StreamEvent } from './types'

/**
 * Ollama's `/v1/*` endpoints are OpenAI Chat Completions-wire-compatible
 * (confirmed live, including real tool-call responses), so this just points
 * the OpenAI SDK at the local server instead of api.openai.com. The API key
 * is unused by Ollama but the SDK requires a non-empty string. The same
 * compatibility extends to `/v1/embeddings`.
 */
export class OllamaProvider implements ModelProvider, EmbeddingProvider {
  readonly id = 'ollama'
  readonly displayName = 'Ollama (local)'
  private client: OpenAI
  /** Native (non-`/v1`) API root, derived from the same configured baseURL — `/api/ps` below lives outside the OpenAI-compat surface. */
  private rootURL: string

  constructor(baseURL = 'http://localhost:11434/v1') {
    this.client = new OpenAI({ apiKey: 'ollama', baseURL })
    this.rootURL = baseURL.replace(/\/v1\/?$/, '')
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list()
    return page.data.map((model) => model.id)
  }

  async countTokens(messages: Message[]): Promise<number> {
    // An approximation of an approximation — local models use their own
    // tokenizers, not OpenAI's — but still far better than a hardcoded 0.
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
   * Reads the model's *actually loaded* context length from `/api/ps` —
   * only currently-loaded (in-VRAM) models are listed there, so this
   * returns undefined for a cold model (nothing to report yet) or on any
   * request failure. Deliberately not `/api/show`'s `model_info`, which
   * reports the model's architectural max (e.g. 131072 for gpt-oss:20b) —
   * Ollama can and does load a model with a much smaller runtime context
   * than that by default (confirmed live: 4096), and trusting the larger
   * architectural number here would reproduce the exact under-trimming bug
   * this method exists to fix.
   */
  async loadedContextWindow(model: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.rootURL}/api/ps`)
      if (!res.ok) return undefined
      const data = (await res.json()) as { models?: { model: string; context_length?: number }[] }
      return data.models?.find((m) => m.model === model)?.context_length
    } catch {
      return undefined
    }
  }
}
