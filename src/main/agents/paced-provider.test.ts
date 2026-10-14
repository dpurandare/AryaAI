import { describe, expect, it } from 'vitest'
import type { CompletionRequest, ModelProvider, StreamEvent } from '../providers/types'
import { classifyTooLarge, isFatalProviderError, QuotaExhaustedError, RequestTooLargeError, retryDelayFromMessage, withPacing } from './paced-provider'

/** A clock the tests control: `sleep` advances it instead of waiting. */
function clock() {
  let t = 1_000_000
  const waits: Array<{ ms: number; reason: string }> = []
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    waits,
    onWait: (ms: number, reason: string) => void waits.push({ ms, reason }),
    advance: (ms: number) => void (t += ms)
  }
}

type Behavior = (req: CompletionRequest) => AsyncIterable<StreamEvent>
const ok = (tokens = 100): Behavior =>
  async function* () {
    yield { type: 'text_delta', text: 'hi' }
    yield { type: 'usage', inputTokens: tokens - 10, outputTokens: 10 }
    yield { type: 'message_stop', stopReason: 'end_turn' }
  }
const fail = (err: unknown): Behavior =>
  // eslint-disable-next-line require-yield
  async function* () {
    throw err
  }
function rateLimit(message: string, headers?: Record<string, string>, status = 429): Error {
  return Object.assign(new Error(message), { status, headers: headers ? new Headers(headers) : undefined })
}
function provider(...behaviors: Behavior[]): ModelProvider & { calls: number } {
  let i = 0
  const p = {
    calls: 0,
    id: 'fake',
    displayName: 'Fake',
    listModels: async () => ['m'],
    countTokens: async () => 0,
    stream(req: CompletionRequest) {
      p.calls++
      return behaviors[Math.min(i++, behaviors.length - 1)](req)
    }
  }
  return p
}
const req: CompletionRequest = { model: 'm', messages: [], maxTokens: 10 }
async function run(p: ModelProvider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of p.stream(req)) out.push(e)
  return out
}

describe('call spacing (requests per minute)', () => {
  it('waits so that two calls start at least minIntervalMs apart, and not at all when the gap has already passed', async () => {
    const c = clock()
    const p = withPacing(provider(ok()), { minIntervalMs: 1000, now: c.now, sleep: c.sleep, onWait: c.onWait })
    await run(p)
    await run(p)
    expect(c.waits).toEqual([{ ms: 1000, reason: 'spacing calls' }])
    c.advance(5000)
    await run(p)
    expect(c.waits).toHaveLength(1) // no wait: 5 s had passed
  })
})

describe('token budget (tokens per minute), from ACTUAL usage', () => {
  it('holds the next call until enough of the window has aged out', async () => {
    const c = clock()
    const p = withPacing(provider(ok(600)), { tokensPerMinute: 1000, now: c.now, sleep: c.sleep, onWait: c.onWait })
    await run(p) // uses 600
    await run(p) // 600 + 600 > 1000 → must wait for call 1 to leave the 60 s window
    expect(c.waits).toHaveLength(1)
    expect(c.waits[0].reason).toMatch(/staying under 1000 tokens\/min/)
    expect(c.waits[0].ms).toBeGreaterThanOrEqual(59_000)
    expect(c.waits[0].ms).toBeLessThanOrEqual(60_000)
  })

  it('does not wait while the window has room', async () => {
    const c = clock()
    const p = withPacing(provider(ok(100)), { tokensPerMinute: 1000, now: c.now, sleep: c.sleep, onWait: c.onWait })
    for (let i = 0; i < 5; i++) await run(p)
    expect(c.waits).toEqual([])
  })

  it('a single call larger than the whole budget is still attempted (the provider will say if it can never fit)', async () => {
    const c = clock()
    const p = withPacing(provider(ok(5000)), { tokensPerMinute: 1000, now: c.now, sleep: c.sleep, onWait: c.onWait })
    await run(p)
    await run(p)
    expect(p.stats.calls).toBe(2) // and did not deadlock
  })

  it('uses the caller\'s estimate for the very first call', async () => {
    const c = clock()
    const p = withPacing(provider(ok(100)), { tokensPerMinute: 1000, estimateTokens: 900, now: c.now, sleep: c.sleep, onWait: c.onWait })
    await run(p)
    expect(c.waits).toEqual([]) // empty window: nothing to wait for
  })
})

describe('429 handling', () => {
  it('waits the Retry-After header (plus a small margin) and then succeeds, counting the retry', async () => {
    const c = clock()
    const p = withPacing(provider(fail(rateLimit('slow down', { 'retry-after': '3' })), ok()), { now: c.now, sleep: c.sleep, onWait: c.onWait })
    const events = await run(p)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(c.waits).toEqual([{ ms: 3250, reason: 'rate limited (attempt 1/8): slow down' }])
    expect(p.stats).toMatchObject({ calls: 2, retries: 1 })
  })

  it('prefers retry-after-ms, and reads "try again in 7.5s" from the message when there is no header (Groq)', async () => {
    const c = clock()
    const p = withPacing(
      provider(fail(rateLimit('x', { 'retry-after-ms': '1500' })), fail(rateLimit('Rate limit reached. Please try again in 7.5s. Need more tokens?')), ok()),
      { now: c.now, sleep: c.sleep, onWait: c.onWait }
    )
    await run(p)
    expect(c.waits.map((w) => w.ms)).toEqual([1750, 7750])
  })

  it('backs off exponentially when the provider gives no hint (Google\'s SDK exposes no headers)', async () => {
    const c = clock()
    const p = withPacing(provider(fail(rateLimit('quota')), fail(rateLimit('quota')), fail(rateLimit('quota')), ok()), { now: c.now, sleep: c.sleep, onWait: c.onWait })
    await run(p)
    expect(c.waits.map((w) => w.ms)).toEqual([1250, 2250, 4250])
  })

  it('gives up after maxRetries and throws the provider\'s own error', async () => {
    const c = clock()
    const err = rateLimit('still limited', { 'retry-after': '1' })
    const p = withPacing(provider(fail(err)), { maxRetries: 2, now: c.now, sleep: c.sleep })
    await expect(run(p)).rejects.toBe(err)
    expect(p.stats.calls).toBe(3)
  })

  it('does not retry an error that is not a rate limit', async () => {
    const c = clock()
    const err = Object.assign(new Error('bad request'), { status: 400 })
    const p = withPacing(provider(fail(err), ok()), { now: c.now, sleep: c.sleep })
    await expect(run(p)).rejects.toBe(err)
    expect(p.stats.calls).toBe(1)
  })

  it('never retries once events have been delivered (the caller has already seen part of the answer)', async () => {
    const c = clock()
    const err = rateLimit('mid-stream')
    const p = withPacing(
      provider(async function* () {
        yield { type: 'text_delta', text: 'partial' } as StreamEvent
        throw err
      }, ok()),
      { now: c.now, sleep: c.sleep }
    )
    await expect(run(p)).rejects.toBe(err)
    expect(p.stats.calls).toBe(1)
  })
})

describe('limits that waiting cannot fix', () => {
  it('a Groq-style TPM 429 whose Requested exceeds Limit is a RequestTooLargeError with both numbers — no retry loop', async () => {
    const c = clock()
    const err = rateLimit('Rate limit reached for model in organization on tokens per minute (TPM): Limit 8000, Used 0, Requested 12345. Please try again in 1.2s.')
    const p = withPacing(provider(fail(err), ok()), { now: c.now, sleep: c.sleep })
    const thrown = await run(p).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequestTooLargeError)
    expect(thrown).toMatchObject({ limit: 8000, requested: 12345 })
    expect(p.stats.calls).toBe(1)
    expect(isFatalProviderError(thrown)).toBe(true)
  })

  it('a 429 whose Requested fits within Limit is an ordinary burst limit and IS retried', async () => {
    const c = clock()
    const err = rateLimit('tokens per minute (TPM): Limit 8000, Used 7000, Requested 3000. Please try again in 4s.')
    const p = withPacing(provider(fail(err), ok()), { now: c.now, sleep: c.sleep })
    await run(p)
    expect(p.stats.calls).toBe(2)
  })

  it.each([
    ['HTTP 413', Object.assign(new Error('Payload Too Large'), { status: 413 })],
    ['request too large text', Object.assign(new Error('Request too large for model'), { status: 400 })],
    ['context length', Object.assign(new Error("This model's maximum context length is 8192 tokens."), { status: 400 })]
  ])('%s is a RequestTooLargeError', async (_n, err) => {
    const c = clock()
    const thrown = await run(withPacing(provider(fail(err)), { now: c.now, sleep: c.sleep })).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequestTooLargeError)
  })

  it('reads the context limit out of the message when it is there', () => {
    expect(classifyTooLarge(Object.assign(new Error("maximum context length is 8192 tokens"), { status: 400 }))?.limit).toBe(8192)
  })

  it('a wait longer than maxWaitMs (a daily quota window) ends the run as QuotaExhaustedError instead of sleeping for hours', async () => {
    const c = clock()
    const err = rateLimit('tokens per day (TPD): Limit 200000, Used 199900, Requested 300. Please try again in 1h12m3s.')
    const p = withPacing(provider(fail(err)), { now: c.now, sleep: c.sleep, maxWaitMs: 120_000 })
    const thrown = await run(p).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(QuotaExhaustedError)
    expect((thrown as QuotaExhaustedError).waitMs).toBe((3600 + 12 * 60 + 3) * 1000)
    expect(c.waits).toEqual([]) // it did not sleep first
    expect(isFatalProviderError(thrown)).toBe(true)
  })
})

describe('retryDelayFromMessage', () => {
  it.each([
    ['Please try again in 7.5s.', 7500],
    ['try again in 890ms', 890],
    ['try again in 2m3.5s', 123500],
    ['try again in 1h2m', 3720000],
    ['try again in 45s', 45000]
  ])('%s → %d ms', (m, ms) => {
    expect(retryDelayFromMessage(m)).toBe(ms)
  })
  it('is undefined when the message names no delay', () => {
    expect(retryDelayFromMessage('rate limited')).toBeUndefined()
    expect(retryDelayFromMessage('try again later')).toBeUndefined()
  })
})

describe('passthrough', () => {
  it('keeps the wrapped provider\'s identity and delegates listModels / countTokens', async () => {
    const p = withPacing(provider(ok()))
    expect(p.id).toBe('fake')
    expect(await p.listModels()).toEqual(['m'])
  })
})
