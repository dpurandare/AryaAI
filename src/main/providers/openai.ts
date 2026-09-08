import OpenAI from 'openai'
import { countTokensApprox, streamOpenAICompatible } from './openai-compatible'
import type { CompletionRequest, Message, ModelProvider, StreamEvent } from './types'

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

  async countTokens(messages: Message[]): Promise<number> {
    return countTokensApprox(undefined, messages)
  }

  stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    return streamOpenAICompatible(this.client, request)
  }
}
