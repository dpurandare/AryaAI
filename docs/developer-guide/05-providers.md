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

`ProviderRegistry` maps an id to a `ProviderDescriptor`:

| Field | Meaning |
|---|---|
| `id`, `displayName` | The stable id stored in settings, and the name shown in the UI. |
| `requiresApiKey` | Whether the provider needs a key stored for it before it can be used. Only local Ollama does not. |
| `supportsEmbeddings` | Whether the provider can **also** produce *embeddings* (a vector of numbers for a piece of text), besides answering chat requests. Embeddings power the memory index behind `search_history` (see [Memory and search history](13-memory-and-search-history.md)); Settings > Search history only offers providers where this is true. It has nothing to do with chat quality. |
| `create(apiKey?, options?)` | Builds the adapter. `ProviderOptions` (today only `promptCaching`) is read from Settings by the caller. |

`createDefaultProviderRegistry()` in `setup.ts` registers the built-ins:

| Id | Adapter | Wire format / SDK | Needs an API key | Can create embeddings |
|---|---|---|---|---|
| `anthropic` | `anthropic.ts` | `@anthropic-ai/sdk` Messages API | yes | no |
| `openai` | `openai.ts` | `openai` SDK, Chat Completions | yes | yes |
| `google` | `google.ts` | `@google/genai` | yes | yes |
| `ollama` | `ollama.ts` | OpenAI-compatible `/v1` plus native `/api` calls | no | yes |
| `ollama-cloud` | `ollama.ts` | the same class pointed at `https://ollama.com/v1`, with a key | yes | yes |
| `groq` | `groq.ts` | OpenAI-compatible at `https://api.groq.com/openai/v1` | yes | no |
| `mistral` | `mistral.ts` | OpenAI-compatible | yes | yes |

"No" under embeddings means the provider can chat but cannot be chosen for the memory index (Anthropic and Groq have no embeddings API here).

`getEmbeddingProvider(providerId, apiKey)` is the only way the app obtains an `EmbeddingProvider`; it is scoped to the providers that implement `embed`, so callers never test for it. `probeEmbeddingDimension` makes one real embed call so Settings can show a model's real vector size.

## Shared translation for OpenAI-style APIs (`openai-compatible.ts`)

OpenAI, Ollama, Groq and Mistral speak the OpenAI Chat Completions format, so `toOpenAIMessages` (our messages to the wire) and the stream parsing are shared. A `user` message of `tool_result` blocks becomes `tool` role messages; `image`, `warning` and `thinking` blocks are never sent to the model. `countTokensApprox` is the fallback estimator (`js-tiktoken` based) for providers without a token-count API.

## Provider-specific behaviour

**Anthropic.** `buildAnthropicParams` adds **prompt-cache breakpoints** (`cache_control`) on the last tool, the system prompt and the last block of the last message, so each round of a tool loop reuses the prefix. Prefix stability is what makes it work: nothing in `tools` or `system` may vary between rounds (a test in `orchestrator.test.ts` asserts it). `promptCaching: false` (Settings) sends a plain request, the escape hatch if the API rejects the markers. Structured output is a **forced tool call**. If the API rejects `temperature` ("deprecated for this model"), the adapter retries once without it and remembers the model.

**Google.** Uses `@google/genai`; structured output through `responseJsonSchema`. Gemini returns a **thought signature** with tool calls that must be echoed back on the next request, which is why `tool_use` blocks carry an optional `thoughtSignature`.

**Ollama.** A local model's loaded context is set at load time by the server and is often much smaller (commonly 4096) than the model advertises. `loadedContextWindow` reads `/api/ps` (what is *actually loaded*) and `configuredContextWindow` reads the model's Modelfile `num_ctx`, so context trimming budgets against the real number. `prepare-context.ts` prefers a live reading, then the configured one, then the static table. The bundled Ollama (see [Runtime and bundling](08-runtime-and-bundling.md)) is reached through the same class by changing its base URL.

**Rate limits (`rate-limit.ts`).** `isRateLimitError` and `retryAfterMsFromError` recognise 429s and the wait the provider asks for; the orchestrator's `handleRateLimitError` uses them to wait and retry. `agents/paced-provider.ts` wraps a provider for the eval scripts to respect per-minute and daily limits on free tiers.

## Model metadata (`src/shared/model-metadata.ts`)

A hand-maintained table used by the UI and the context logic: `contextWindowFor(model)`, `maxOutputTokensFor(model)`, `pricePerMillionTokens(model)` and `estimateCost`. Unknown models fall back to conservative defaults, and the cost meter shows an estimate only. Update it when a provider releases a model; a stale entry makes the meter wrong, not the app.

## How the active provider is chosen

Settings keys: `activeProviderId` (default `openai`) and `model:<providerId>` per provider. The API key comes from the secret store (`security/keychain.ts`, keyed by provider id). `runChat` resolves all three at the start of every turn and fails early, with a clear message, if one is missing.

## Known limitation: the bundled Ollama

When the bundled Ollama server is running (all installers), `ipc/register.ts` calls `setBundledOllamaBaseUrl()` and `setup.ts` points **every** `ollama` provider instance (chat and embeddings) at it. The bundled server uses its own models folder (`<userData>/ollama-models`), so the user's own Ollama models are not reachable from an installer. This is tracked as TASKS #214 with options for a fix.

## Adding a provider

The shortest path is a provider that speaks the OpenAI Chat Completions format (Groq is the smallest example, `groq.ts`, about 50 lines). A provider with its own format (Anthropic, Google) needs a full adapter. The same steps apply to both, and the short checklist is in the [extension checklists](appendix-extension-checklists.md).

**What you do not touch.** The UI has no hard-coded provider list: Settings gets it from the registry through the `providers:list` channel. API keys are stored by provider id through the generic `setApiKey`/`getApiKey` (`security/keychain.ts`), and the chosen provider and model live in the `activeProviderId` and `model:<providerId>` settings. So no renderer, preload, IPC or keychain change is needed.

### 1. Write the adapter (`src/main/providers/<name>.ts`)

Implement `ModelProvider` (`providers/types.ts`):

| Member | Must do |
|---|---|
| `id`, `displayName` | Same values you register in step 2. |
| `listModels()` | Return the model ids the account can use (feeds the model picker). |
| `stream(request)` | Return an `AsyncIterable<StreamEvent>` for one round (see below). |
| `countTokens(messages, model)` | A real count if the API has one, otherwise `countTokensApprox` (`openai-compatible.ts`). |
| `loadedContextWindow?`, `configuredContextWindow?` | Optional. Only a provider whose context size can differ from the static table (a local server) should implement them. |

For an OpenAI-compatible service the whole adapter is a constructor and two one-liners:

```ts
export class AcmeProvider implements ModelProvider {
  readonly id = 'acme'
  readonly displayName = 'Acme'
  private client: OpenAI
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.acme.example/v1' })
  }
  async listModels() { return (await this.client.models.list()).data.map((m) => m.id) }
  countTokens(messages: Message[]) { return Promise.resolve(countTokensApprox(undefined, messages)) }
  stream(request: CompletionRequest) { return streamOpenAICompatible(this.client, request) }
}
```

`streamOpenAICompatible` already does the translation rules from the start of this page (text, thinking, tool calls, one usage event, the stop reason). **Check the service's real behaviour first** rather than assuming "compatible": streaming format, tool-call shape, whether `temperature: 0` is honoured, whether it returns reasoning, and whether it has an embeddings endpoint. Record what you confirmed in the class comment, as `groq.ts` does.

For a provider with its own SDK, translate its stream yourself and meet the contract at the top of this page: `tool_use` blocks with parsed input, **one** usage event per round, a correct `stopReason` (`tool_use`, `end_turn`, `max_tokens`), and a clear error if `StructuredOutputRequest` cannot be honoured (the caller then falls back to a plain-prompt request).

### 2. Register it (`providers/setup.ts`)

Add an entry to `createDefaultProviderRegistry()`: `id`, `displayName`, `requiresApiKey`, `supportsEmbeddings`, and `create(apiKey)`. Pick `requiresApiKey: false` only for a local service.

### 3. Embeddings (only if the provider has an embeddings API)

Implement `EmbeddingProvider.embed(texts, model)`, set `supportsEmbeddings: true`, and add a `case` to `getEmbeddingProvider()`. That is what makes it appear in Settings > Search history.

### 4. Model metadata (`src/shared/model-metadata.ts`)

Add the context windows (`CONTEXT_WINDOWS`, matched by model-id prefix), the per-call output ceilings (`MAX_OUTPUT`) and, only if you have confirmed numbers, prices. Without entries a model gets a conservative default context window, flagged as an estimate, and no cost is shown; do not guess numbers.

### 5. Rate limits

`isRateLimitError` (`providers/rate-limit.ts`) recognises a thrown error with `status === 429`, which the OpenAI, Anthropic and Google SDKs all produce, so the app's retry and pacing (`agents/paced-provider.ts`, `handleRateLimitError`) work with no extra code. If your SDK throws a different shape, make the adapter throw an error carrying `status` (and `headers` with `Retry-After` if known).

### 6. Test

Write `<name>.test.ts` with a mocked SDK (copy `groq.test.ts`: mock the SDK module, import the adapter after the mock, feed a fake stream, assert the `StreamEvent`s and the constructor arguments). Cover: text, a tool call, usage reported once, each stop reason, `listModels`, and a structured-output request. Add a case to the orchestrator's mock-provider tests only if the provider introduces a new failure shape.

### 7. Verify with a real model

Typecheck and the full test run only prove the translation. Spend a little quota deliberately: run one real turn with a tool call, check the usage numbers and the stop reasons, then run `routing-eval.mts` for the model (see [Getting started](02-getting-started.md)).

### 8. Document it

Add the row to the registry table above and any difference from the others to this page, and the provider (name, where to get a key, whether it is free or local) to the User Guide ([Providers and keys](../user-guide/03-providers-and-keys.md)).
