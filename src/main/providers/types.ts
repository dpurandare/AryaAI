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

/**
 * Asks the provider to constrain the reply to this JSON Schema (provider-enforced structured output) instead of merely asking for JSON in the
 * prompt. Used by one-shot classification calls that have no tools. Each adapter maps it to its provider's mechanism — OpenAI-compatible
 * `response_format` json_schema, Gemini `responseJsonSchema`, Anthropic a forced tool call — and always delivers the JSON as ordinary
 * `text_delta`s, so callers read it the same way whatever the provider. A provider or model that does not accept it throws; the caller falls back.
 */
export interface StructuredOutputRequest {
  name: string
  schema: Record<string, unknown>
}

export interface CompletionRequest {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens: number
  signal?: AbortSignal
  /** Only meaningful without `tools`. */
  structuredOutput?: StructuredOutputRequest
  /**
   * 0 (deterministic) .. 1 (provider default-ish). Undefined = send nothing, provider's own default
   * applies. Settings > Model behavior (ipc/register.ts's TEMPERATURE_SETTING_KEY), threaded through
   * unchanged by every adapter — never clamped or reinterpreted per-provider here, since 0..1 is a safe
   * subset of every supported provider's own range (Anthropic caps at 1; OpenAI/Google go to 2).
   */
  temperature?: number
}

/** Per-turn provider construction options, read from Settings by the caller. Only Anthropic uses `promptCaching` today. */
export interface ProviderOptions {
  /** Default true. False sends no `cache_control` markers (Settings > Prompt caching). */
  promptCaching?: boolean
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
 * from chat (ModelProvider). Only openai/google/ollama/mistral implement
 * this; Anthropic and Groq have no embeddings API at all. `embed` is
 * required, not optional,
 * because callers only ever obtain an EmbeddingProvider via
 * `providers/setup.ts`'s `getEmbeddingProvider()`, which is scoped to the
 * closed set of providers that actually implement it — there's no code path
 * where an EmbeddingProvider instance exists without a working `embed`.
 */
export interface EmbeddingProvider {
  readonly id: string
  embed(texts: string[], model: string): Promise<number[][]>
  /**
   * TASKS #224: an identifier of the model's actual weights (Ollama's digest), when the server can report it.
   * `undefined` when unknown or unsupported; the search index uses it to notice that the model behind a name changed.
   */
  modelDigest?(model: string): Promise<string | undefined>
  /** The models this server offers, when it can list them (Settings' embedding-model dropdown). */
  listModels?(): Promise<string[]>
}
