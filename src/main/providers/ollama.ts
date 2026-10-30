import OpenAI from 'openai'
import { countTokensApprox, streamOpenAICompatible } from './openai-compatible'
import type { CompletionRequest, EmbeddingProvider, Message, ModelProvider, StreamEvent } from './types'

/**
 * Ollama's `/v1/*` endpoints are OpenAI Chat Completions-wire-compatible
 * (confirmed live, including real tool-call responses), so this just points
 * the OpenAI SDK at the local server instead of api.openai.com. For local
 * use the API key is unused by Ollama but the SDK requires a non-empty
 * string, hence the `'ollama'` default. The same compatibility extends to
 * `/v1/embeddings`.
 *
 * Also backs the separate "Ollama Cloud" provider (#167) — ollama.com's
 * hosted offering exposes the identical OpenAI-compatible surface at
 * `https://ollama.com/v1`, just with a real API key required
 * (docs.ollama.com/api/openai-compatibility, confirmed 2026-09-29) — so
 * this one class serves both, distinguished only by the constructor args
 * `providers/setup.ts` passes in for each registered provider id.
 */
/**
 * The OpenAI SDK's connection errors leave `name` as 'Error' (only the constructor's name says what they are), so both are checked.
 * Checking `instanceof` would need the SDK's class, which a mocked SDK in tests does not have.
 */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const names = new Set(['APIConnectionError', 'APIConnectionTimeoutError'])
  return names.has(err.name) || names.has(err.constructor.name)
}

export class OllamaProvider implements ModelProvider, EmbeddingProvider {
  readonly id: string
  readonly displayName: string
  private client: OpenAI
  /** Native (non-`/v1`) API root, derived from the same configured baseURL — `/api/ps`/`/api/show` below live outside the OpenAI-compat surface. Not verified against Ollama Cloud specifically; both callers already degrade to `undefined` on any failure (unreachable/unauthorized/nonexistent), so an unsupported cloud response is silently harmless, just a wasted round-trip. */
  private rootURL: string

  constructor(
    baseURL = 'http://localhost:11434/v1',
    apiKey = 'ollama',
    id = 'ollama',
    displayName = 'Ollama (local)'
  ) {
    this.id = id
    this.displayName = displayName
    this.client = new OpenAI({ apiKey, baseURL })
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
    // The local Ollama may simply not be running (#214): say so plainly instead of the SDK's bare "Connection error."
    if (this.id !== 'ollama') return streamOpenAICompatible(this.client, request)
    const inner = streamOpenAICompatible(this.client, request)
    const root = this.rootURL
    return (async function* () {
      try {
        yield* inner
      } catch (err) {
        if (isConnectionError(err)) {
          throw new Error(
            `Ollama (local) is not running at ${root}. Start Ollama, or correct its address in Settings > Ollama (local chat), then send again. Nothing was switched to another model.`
          )
        }
        throw err
      }
    })()
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const response = await this.client.embeddings.create({ model, input: texts })
    return response.data.map((item) => item.embedding)
  }

  /** The digest Ollama reports for an installed model (`/api/tags`), or undefined when it is unknown or the server cannot be reached. */
  async modelDigest(model: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.rootURL}/api/tags`)
      if (!res.ok) return undefined
      const data = (await res.json()) as { models?: { name?: string; model?: string; digest?: string }[] }
      const wanted = model.includes(':') ? [model] : [model, `${model}:latest`]
      return data.models?.find((m) => wanted.includes(m.name ?? '') || wanted.includes(m.model ?? ''))?.digest
    } catch {
      return undefined
    }
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

  /**
   * `/api/show`'s `parameters` field is a plain, whitespace-aligned
   * `key value` block (not structured JSON — confirmed live, e.g.
   * `"num_ctx                        131072\ntemperature                    1"`),
   * present whenever the Modelfile sets `PARAMETER num_ctx ...` explicitly,
   * empty/absent otherwise. Works for both a loaded and a cold model, since
   * it reflects the model's saved configuration, not its current runtime
   * state — see the doc comment on ModelProvider.configuredContextWindow
   * for why this matters (Ollama idles a model out of VRAM by default,
   * which is most of the time a real chat session is just sitting between
   * messages).
   */
  async configuredContextWindow(model: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.rootURL}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      })
      if (!res.ok) return undefined
      const data = (await res.json()) as { parameters?: string }
      const match = data.parameters?.match(/^num_ctx\s+(\d+)\s*$/m)
      return match ? Number(match[1]) : undefined
    } catch {
      return undefined
    }
  }
}
