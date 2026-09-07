/**
 * Unified provider adapter layer: every LLM provider (Anthropic, OpenAI,
 * Google, Ollama, ...) is wrapped behind this interface so the rest of the
 * app (agents, orchestrator, UI) never touches a provider SDK directly.
 */
import type { ContentBlock, Message, StreamEvent } from '@shared/protocol'

export type { ContentBlock, Message, StreamEvent }

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CompletionRequest {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens: number
  signal?: AbortSignal
}

export interface ModelProvider {
  readonly id: string
  readonly displayName: string
  listModels(): Promise<string[]>
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>
  countTokens(messages: Message[], model: string): Promise<number>
}
