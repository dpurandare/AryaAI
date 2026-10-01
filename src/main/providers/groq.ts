import OpenAI from 'openai'
import { countTokensApprox, streamOpenAICompatible } from './openai-compatible'
import type { CompletionRequest, Message, ModelProvider, StreamEvent } from './types'

/**
 * Groq's `/openai/v1/*` endpoints are OpenAI Chat Completions-wire-compatible
 * — confirmed against Groq's own current docs (console.groq.com/docs/openai,
 * .../docs/api-reference, .../docs/tool-use), not assumed: base URL
 * `https://api.groq.com/openai/v1`, a standard Bearer API key, identical
 * `/v1/models` listing, identical SSE streaming ("partial message deltas...
 * terminated by data: [DONE]"), and identical tool-call request/response
 * shapes (`tools: [{type:"function", function:{...}}]` in, `tool_calls:
 * [{id, type:"function", function:{name, arguments}}]` out) — same pattern
 * as the Ollama adapter, pointing the OpenAI SDK at a different base URL
 * rather than a from-scratch adapter.
 *
 * Groq's docs list real OpenAI-compatibility gaps (`logprobs`, `logit_bias`,
 * `top_logprobs`, `messages[].name`, `N != 1`, and `temperature: 0` silently
 * becoming `1e-8`) — `toOpenAIMessages`/`streamOpenAICompatible` (openai-compatible.ts) never set
 * `logprobs`/`logit_bias`/`top_logprobs`/`messages[].name`/`N`, so those stay unreachable here, but
 * `temperature` (CompletionRequest.temperature, Settings > Model behavior) now is sent when set — its
 * floor there is a safe 0..1, so an exact `0` is possible if someone sets the slider to its minimum;
 * Groq's silent 0 -> 1e-8 substitution is a real, reachable quirk for that one value on this provider.
 *
 * No `/v1/embeddings` endpoint exists on Groq (confirmed against its API
 * reference) — unlike OpenAI/Ollama, this does not implement
 * `EmbeddingProvider`.
 */
export class GroqProvider implements ModelProvider {
  readonly id = 'groq'
  readonly displayName = 'Groq'
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' })
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list()
    return page.data.map((model) => model.id)
  }

  async countTokens(messages: Message[]): Promise<number> {
    // An approximation of an approximation, same caveat as Ollama's —
    // Groq's hosted models (Llama, GPT-OSS) use their own tokenizers, not
    // OpenAI's — but still far better than a hardcoded 0.
    return countTokensApprox(undefined, messages)
  }

  stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    return streamOpenAICompatible(this.client, request)
  }
}
