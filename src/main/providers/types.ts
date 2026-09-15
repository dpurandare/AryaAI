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
  /**
   * The real context window a provider is *currently* running a model with,
   * if that can differ from its static, hand-maintained entry in
   * model-metadata.ts and is worth checking live. Only Ollama implements
   * this today — a local model's loaded context is set at load time by the
   * Ollama server (independently of the model's own architectural max) and
   * can be smaller than model-metadata.ts's generic local-model estimate,
   * which under-trims the conversation and risks the exact failure this
   * was added for: a prompt silently truncated by the server mid-turn,
   * producing zero visible output (see prepare-context.ts's use of this).
   * Cloud providers (Anthropic/OpenAI/Google) have no such live variance —
   * their context window is a fixed, known property of the model id — so
   * this stays optional rather than forcing every provider to implement a
   * no-op.
   */
  loadedContextWindow?(model: string): Promise<number | undefined>
  /**
   * The context window a model is *configured* to load with (its
   * Modelfile's own `num_ctx`, when one is set), available even while the
   * model is currently unloaded/cold — unlike `loadedContextWindow`, which
   * only reports a *currently running* model's actual runtime context and
   * returns undefined otherwise. A real, confirmed number either way (not
   * a guess) since it's what the server will actually load the model with
   * next; `prepare-context.ts`'s `resolveContextWindow` prefers a live
   * reading when one exists, then this, then finally model-metadata.ts's
   * generic static fallback. Found needed live: a custom 128K-context
   * Modelfile still showed the flat 4096-token local-model fallback
   * whenever Ollama had idled the model out of VRAM (its default
   * behavior), which most of the time a real session is just sitting
   * between messages — `loadedContextWindow` alone left the UI meter wrong
   * far more often than not for exactly this common case.
   */
  configuredContextWindow?(model: string): Promise<number | undefined>
}

/**
 * A provider capable of generating text embeddings — a separate capability
 * from chat (ModelProvider). Only openai/google/ollama implement this;
 * Anthropic has no embeddings API at all. `embed` is required, not optional,
 * because callers only ever obtain an EmbeddingProvider via
 * `providers/setup.ts`'s `getEmbeddingProvider()`, which is scoped to the
 * closed set of providers that actually implement it — there's no code path
 * where an EmbeddingProvider instance exists without a working `embed`.
 */
export interface EmbeddingProvider {
  readonly id: string
  embed(texts: string[], model: string): Promise<number[][]>
}
