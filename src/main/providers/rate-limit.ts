/**
 * TASKS.md #91 — provider-agnostic rate-limit detection. Confirmed against
 * each SDK's own error types, not guessed:
 *  - `@anthropic-ai/sdk`'s `APIError`/`RateLimitError` (`error.d.ts`) exposes
 *    a real `status: number` and `headers: Headers`.
 *  - `openai`'s `APIError`/`RateLimitError` (shared by OpenAI, Ollama, Groq,
 *    and Mistral via `openai-compatible.ts`) has the identical shape —
 *    same `status`/`headers` fields, same 429 convention.
 *  - `@google/genai`'s `ApiError` also exposes `status: number`, but no
 *    `headers` at all — Google's SDK gives no way to read a real
 *    `Retry-After` value, so that path always falls back to backoff.
 * Duck-typed on `.status === 429` rather than importing each SDK's own
 * error class — genuinely a shared, stable field across all 3 SDK families
 * here, not the kind of brittle per-SDK shape-guessing this codebase
 * otherwise avoids (see orchestrator.ts's own note on why abort detection
 * uses the signal, not error-shape matching, for contrast).
 *
 * Important: all 3 SDKs already retry a 429 internally a couple of times
 * (default `maxRetries: 2`) before ever throwing up to this app's own code
 * — confirmed by reading `openai`'s `client.js` (`shouldRetry`/
 * `retryRequest`) and equivalent Anthropic/Google behavior. By the time
 * anything here ever sees a rate-limit error, the SDK's own short internal
 * backoff has already been exhausted; this module's retry (in
 * `orchestrator.ts`) is a second, app-level layer for when that wasn't
 * enough — the common real case on a free/low tier, where the actual
 * rate-limit window is longer than the SDK's own capped backoff.
 */

export function isRateLimitError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status: unknown }).status === 429
}

/**
 * The provider's own suggested wait, in milliseconds, read directly from
 * the error's real HTTP headers when available — never a guess when a real
 * value exists. Anthropic/OpenAI-family errors carry a real `Headers`
 * object; Google's `ApiError` has none, so this always returns `undefined`
 * for a Gemini-sourced error (the caller falls back to exponential
 * backoff). Prefers the non-standard-but-common `retry-after-ms` (exact
 * milliseconds) over the standard `retry-after` (whole seconds, or an HTTP
 * date) when both are present, matching the precision each header actually
 * offers.
 */
export function retryAfterMsFromError(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown } | null)?.headers
  if (!(headers instanceof Headers)) return undefined

  const msHeader = headers.get('retry-after-ms')
  if (msHeader) {
    const ms = Number.parseFloat(msHeader)
    if (Number.isFinite(ms) && ms >= 0) return ms
  }

  const secondsHeader = headers.get('retry-after')
  if (!secondsHeader) return undefined
  const seconds = Number.parseFloat(secondsHeader)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  // Retry-After can also be an HTTP-date rather than a delta-seconds value.
  const untilMs = Date.parse(secondsHeader) - Date.now()
  return Number.isFinite(untilMs) && untilMs >= 0 ? untilMs : undefined
}
