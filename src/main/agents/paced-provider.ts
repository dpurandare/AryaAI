import { isRateLimitError, retryAfterMsFromError } from '../providers/rate-limit'
import type { CompletionRequest, ModelProvider, StreamEvent } from '../providers/types'

/**
 * A ModelProvider wrapper that lives within a provider's limits, for the evaluation scripts (routing-eval, cache-probe) on free / low tiers —
 * Groq and Mistral in particular. Three separate limits, three separate handlings:
 *
 *  - **Call frequency (requests per minute):** `minIntervalMs` spaces the start of calls.
 *  - **Token throughput (tokens per minute):** a sliding one-minute window over the ACTUAL tokens each call used (input + output, from its
 *    `usage` event); before a call, if the window plus the previous call's size would exceed `tokensPerMinute`, wait for old entries to age out.
 *  - **A 429 anyway:** wait what the provider says (`Retry-After` header, or "try again in 7.5s" in the message), else back off exponentially;
 *    retry up to `maxRetries`. The SDKs already retry twice internally, so by the time an error reaches here a short wait was not enough.
 *
 * And two cases where waiting is pointless, which end the run instead of burning time:
 *  - **The request can never fit** — a 413 / "request too large" / context-length error, or Groq's 429 "tokens per minute: Limit 6000, Requested
 *    12000" (Requested > Limit): no amount of waiting helps. Thrown as `RequestTooLargeError`, with the limit when the message gives it.
 *  - **A long quota window** — a daily token limit asks for a wait of hours: thrown as `QuotaExhaustedError` when the wait exceeds `maxWaitMs`.
 *
 * Retries only happen before the first event of a call was delivered (a rate-limit error arrives at the start of the request); an error
 * after events have been yielded propagates unchanged.
 */

export class RequestTooLargeError extends Error {
  constructor(
    message: string,
    /** The model's / tier's limit in tokens, when the provider said. */
    readonly limit?: number,
    /** What this request needed, when the provider said. */
    readonly requested?: number
  ) {
    super(message)
    this.name = 'RequestTooLargeError'
  }
}

export class QuotaExhaustedError extends Error {
  constructor(
    message: string,
    readonly waitMs: number
  ) {
    super(message)
    this.name = 'QuotaExhaustedError'
  }
}

/** Errors that end an evaluation run rather than count as one failed case. */
export function isFatalProviderError(err: unknown): err is RequestTooLargeError | QuotaExhaustedError {
  return err instanceof RequestTooLargeError || err instanceof QuotaExhaustedError
}

export interface PaceOptions {
  /** Minimum gap between the START of two calls. */
  minIntervalMs?: number
  /** Budget of tokens (input + output) in any sliding 60-second window. */
  tokensPerMinute?: number
  /** Tokens to assume for the first call, before any usage has been observed. */
  estimateTokens?: number
  /** 429 retries per call (default 8). */
  maxRetries?: number
  /** Longest single wait accepted (default 120 s); a longer requested wait means a quota window, not a burst limit. */
  maxWaitMs?: number
  /** Injectable for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Told about every wait, so a long run can show why it is quiet. */
  onWait?: (ms: number, reason: string) => void
}

export interface PaceStats {
  calls: number
  retries: number
  waitedMs: number
}

const WINDOW_MS = 60_000

/** "try again in 7.5s" / "in 890ms" / "in 2m3.5s", as Groq and others put it in the 429 message. */
export function retryDelayFromMessage(message: string): number | undefined {
  const m = /try again in\s+(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?\s*(?:(\d+(?:\.\d+)?)\s*ms)?/i.exec(message)
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined
  const [, h, min, s, ms] = m
  return (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000 + Number(ms ?? 0)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Recognises "this request can never succeed here" and pulls out the numbers the provider gave. */
export function classifyTooLarge(err: unknown): RequestTooLargeError | undefined {
  const message = messageOf(err)
  const status = (err as { status?: unknown } | null)?.status
  // Groq-style 429: "... tokens per minute (TPM): Limit 6000, Requested 12300 ..." — Requested above Limit can never fit.
  const tpm = /Limit\s+(\d+)\b[^.]{0,80}?Requested\s+(\d+)/i.exec(message) // "Limit 6000, Requested 12300" or "Limit 6000, Used 4500, Requested 2000"
  if (tpm && Number(tpm[2]) > Number(tpm[1])) {
    return new RequestTooLargeError(`Request needs ~${tpm[2]} tokens but the limit is ${tpm[1]} per minute on this model / tier.`, Number(tpm[1]), Number(tpm[2]))
  }
  if (status === 413 || /request too large|reduce (?:your|the) (?:message|prompt|input)|context[_ ]length|maximum context|too many tokens/i.test(message)) {
    const limit = /maximum context length is (\d+)/i.exec(message)?.[1] ?? /limit\s+(\d+)/i.exec(message)?.[1]
    return new RequestTooLargeError(`The request does not fit this model: ${message.replace(/\s+/g, ' ').slice(0, 220)}`, limit ? Number(limit) : undefined)
  }
  return undefined
}

export function withPacing(provider: ModelProvider, opts: PaceOptions = {}): ModelProvider & { stats: PaceStats } {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxRetries = opts.maxRetries ?? 8
  const maxWaitMs = opts.maxWaitMs ?? 120_000
  const stats: PaceStats = { calls: 0, retries: 0, waitedMs: 0 }
  const window: Array<{ at: number; tokens: number }> = []
  let lastStart = -Infinity
  let lastSize = opts.estimateTokens ?? 0

  async function wait(ms: number, reason: string): Promise<void> {
    if (ms <= 0) return
    stats.waitedMs += ms
    opts.onWait?.(ms, reason)
    await sleep(ms)
  }

  async function beforeCall(): Promise<void> {
    if (opts.minIntervalMs) await wait(lastStart + opts.minIntervalMs - now(), 'spacing calls')
    if (opts.tokensPerMinute) {
      for (;;) {
        const t = now()
        while (window.length && t - window[0].at >= WINDOW_MS) window.shift()
        const used = window.reduce((n, e) => n + e.tokens, 0)
        if (used + lastSize <= opts.tokensPerMinute || window.length === 0) break
        // Wait until enough of the oldest entries have aged out.
        let freed = 0
        let until = window[0].at + WINDOW_MS
        for (const e of window) {
          freed += e.tokens
          until = e.at + WINDOW_MS
          if (used - freed + lastSize <= opts.tokensPerMinute) break
        }
        await wait(Math.max(until - t, 50), `staying under ${opts.tokensPerMinute} tokens/min`)
      }
    }
    lastStart = now()
  }

  return {
    stats,
    id: provider.id,
    displayName: provider.displayName,
    listModels: () => provider.listModels(),
    countTokens: (messages, model) => provider.countTokens(messages, model),
    loadedContextWindow: provider.loadedContextWindow?.bind(provider),
    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      for (let attempt = 0; ; attempt++) {
        await beforeCall()
        stats.calls++
        let yielded = false
        let usedTokens = 0
        try {
          for await (const ev of provider.stream(request)) {
            yielded = true
            if (ev.type === 'usage') usedTokens = ev.inputTokens + ev.outputTokens
            yield ev
          }
          if (usedTokens > 0) {
            window.push({ at: now(), tokens: usedTokens })
            lastSize = usedTokens
          }
          return
        } catch (err) {
          if (yielded) throw err
          const tooLarge = classifyTooLarge(err)
          if (tooLarge) throw tooLarge
          if (!isRateLimitError(err) || attempt >= maxRetries) throw err
          const requested = retryAfterMsFromError(err) ?? retryDelayFromMessage(messageOf(err))
          const delay = requested ?? Math.min(2 ** attempt * 1000, 30_000)
          if (delay > maxWaitMs) {
            throw new QuotaExhaustedError(`Rate limited for ${Math.round(delay / 1000)}s (${Math.round(delay / 60_000)} min) — a quota window, not a burst. ${messageOf(err).replace(/\s+/g, ' ').slice(0, 160)}`, delay)
          }
          stats.retries++
          await wait(delay + 250, `rate limited (attempt ${attempt + 1}/${maxRetries}): ${messageOf(err).replace(/\s+/g, ' ').slice(0, 160)}`)
        }
      }
    }
  }
}
