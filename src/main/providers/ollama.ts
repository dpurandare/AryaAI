import OpenAI from 'openai'
import { countTokensApprox, streamOpenAICompatible } from './openai-compatible'
import type { CompletionRequest, Message, ModelProvider, StreamEvent } from './types'

/**
 * Ollama's `/v1/*` endpoints are OpenAI Chat Completions-wire-compatible
 * (confirmed live, including real tool-call responses), so this just points
 * the OpenAI SDK at the local server instead of api.openai.com. The API key
 * is unused by Ollama but the SDK requires a non-empty string.
 */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama'
  readonly displayName = 'Ollama (local)'
  private client: OpenAI

  constructor(baseURL = 'http://localhost:11434/v1') {
    this.client = new OpenAI({ apiKey: 'ollama', baseURL })
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
}
