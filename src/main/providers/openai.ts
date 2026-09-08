import OpenAI from 'openai'
import { streamOpenAICompatible } from './openai-compatible'
import type { CompletionRequest, ModelProvider, StreamEvent } from './types'

export class OpenAIProvider implements ModelProvider {
  readonly id = 'openai'
  readonly displayName = 'OpenAI'
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list()
    return page.data.map((model) => model.id)
  }

  async countTokens(): Promise<number> {
    // OpenAI has no standalone token-counting endpoint; usage is read off
    // each response's `usage` field instead (see TASKS.md #46).
    return 0
  }

  stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    return streamOpenAICompatible(this.client, request)
  }
}
