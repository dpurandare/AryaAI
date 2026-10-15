# 5. Providers

Every AI provider is wrapped behind one interface, so the orchestrator, agents and UI never touch a provider SDK. The code is in `src/main/providers/`.

## The interface (`types.ts`)

```ts
interface ModelProvider {
  readonly id: string
  readonly displayName: string
  listModels(): Promise<string[]>
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>
  countTokens(messages: Message[], model: string): Promise<number>
  loadedContextWindow?(model: string): Promise<number | undefined>      // live window (Ollama)
  configuredContextWindow?(model: string): Promise<number | undefined>  // Modelfile num_ctx (Ollama)
}
interface EmbeddingProvider {
  readonly id: string
  embed(texts: string[], model: string): Promise<number[][]>
}
```

A `CompletionRequest` carries `model`, `system`, `messages` (the shared `Message`/`ContentBlock` types from `src/shared/protocol.ts`), optional `tools` (`ToolDefinition`: name, description, JSON-Schema input), `maxTokens`, an `AbortSignal`, an optional `temperature` and an optional `structuredOutput`.

`stream()` yields **`StreamEvent`s** (`text_delta`, `thinking_delta`, `tool_use_start`/`tool_use_delta`, `usage`, `message_stop` with a stop reason of `end_turn`, `tool_use`, `max_tokens` or `aborted`, and `error`). Every adapter translates its provider's wire format into these events, so everything above it is provider-neutral.

Two rules adapters follow:

- **Usage is one clean event per round.** Some providers repeat a cumulative usage total across chunks; the adapter keeps the last one and reports it once. Consumers sum usage events, so repeats would be double-counted.
- **Structured output always arrives as ordinary `text_delta`s**, so a caller reads a JSON reply the same way whatever the provider.

## The registry (`registry.ts`, `setup.ts`)

`ProviderRegistry` maps an id to a `ProviderDescriptor`: `id`, `displayName`, `requiresApiKey`, `supportsEmbeddings`, and `create(apiKey?, options?)`. `createDefaultProviderRegistry()` in `setup.ts` registers the built-ins; `ProviderOptions` (today only `promptCaching`) is read from Settings by the caller.

| Id | Adapter | Wire format / SDK | Embeddings |
|---|---|---|---|
| `anthropic` | `anthropic.ts` | `@anthropic-ai/sdk` Messages API | no |
| `openai` | `openai.ts` | `openai` SDK, Chat Completions | yes |
| `google` | `google.ts` | `@google/genai` | yes |
| `ollama` | `ollama.ts` | OpenAI-compatible `/v1` plus native `/api` calls | yes |
| `ollama-cloud` | `ollama.ts` | the same class pointed at `https://ollama.com/v1` with a key | yes |
| `groq` | `groq.ts` | OpenAI-compatible at `https://api.groq.com/openai/v1` | no |
| `mistral` | `mistral.ts` | OpenAI-compatible | yes |

`getEmbeddingProvider(providerId, apiKey)` is the only way the app obtains an `EmbeddingProvider`; it is scoped to the providers that implement `embed`, so callers never test for it. `probeEmbeddingDimension` makes one real embed call so Settings can show a model's real vector size.

## Shared translation for OpenAI-style APIs (`openai-compatible.ts`)

OpenAI, Ollama, Groq and Mistral speak the OpenAI Chat Completions format, so `toOpenAIMessages` (our messages to the wire) and the stream parsing are shared. A `user` message of `tool_result` blocks becomes `tool` role messages; `image`, `warning` and `thinking` blocks are never sent to the model. `countTokensApprox` is the fallback estimator (`js-tiktoken` based) for providers without a token-count API.

## Provider-specific behaviour

**Anthropic.** `buildAnthropicParams` adds **prompt-cache breakpoints** (`cache_control`) on the last tool, the system prompt and the last block of the last message, so each round of a tool loop reuses the prefix. Prefix stability is what makes it work: nothing in `tools` or `system` may vary between rounds (a test in `orchestrator.test.ts` asserts it). `promptCaching: false` (Settings) sends a plain request, the escape hatch if the API rejects the markers. Structured output is a **forced tool call**. If the API rejects `temperature` ("deprecated for this model"), the adapter retries once without it and remembers the model.

**Google.** Uses `@google/genai`; structured output through `responseJsonSchema`. Gemini returns a **thought signature** with tool calls that must be echoed back on the next request, which is why `tool_use` blocks carry an optional `thoughtSignature`.

**Ollama.** A local model's loaded context is set at load time by the server and is often much smaller (commonly 4096) than the model advertises. `loadedContextWindow` reads `/api/ps` (what is *actually loaded*) and `configuredContextWindow` reads the model's Modelfile `num_ctx`, so context trimming budgets against the real number. `prepare-context.ts` prefers a live reading, then the configured one, then the static table. The bundled Ollama (see [Runtime and bundling](08-runtime-and-bundling.md) when written) is reached through the same class by changing its base URL.

**Rate limits (`rate-limit.ts`).** `isRateLimitError` and `retryAfterMsFromError` recognise 429s and the wait the provider asks for; the orchestrator's `handleRateLimitError` uses them to wait and retry. `agents/paced-provider.ts` wraps a provider for the eval scripts to respect per-minute and daily limits on free tiers.

## Model metadata (`src/shared/model-metadata.ts`)

A hand-maintained table used by the UI and the context logic: `contextWindowFor(model)`, `maxOutputTokensFor(model)`, `pricePerMillionTokens(model)` and `estimateCost`. Unknown models fall back to conservative defaults, and the cost meter shows an estimate only. Update it when a provider releases a model; a stale entry makes the meter wrong, not the app.

## How the active provider is chosen

Settings keys: `activeProviderId` (default `openai`) and `model:<providerId>` per provider. The API key comes from the secret store (`security/keychain.ts`, keyed by provider id). `runChat` resolves all three at the start of every turn and fails early, with a clear message, if one is missing.

## Known limitation: the bundled Ollama

When the bundled Ollama server is running (all installers), `ipc/register.ts` calls `setBundledOllamaBaseUrl()` and `setup.ts` points **every** `ollama` provider instance (chat and embeddings) at it. The bundled server uses its own models folder (`<userData>/ollama-models`), so the user's own Ollama models are not reachable from an installer. This is tracked as TASKS #214 with options for a fix.

## Adding a provider

See the checklist in the [extension checklists](appendix-extension-checklists.md) when written. In short: write an adapter implementing `ModelProvider` (and `EmbeddingProvider` if it has an embeddings API), reusing `openai-compatible.ts` if it speaks the OpenAI format; register it in `createDefaultProviderRegistry()` (and `getEmbeddingProvider` if it embeds); add its models to `model-metadata.ts`; write adapter tests with a mocked SDK; and, if it differs from the others, say so in this page.
