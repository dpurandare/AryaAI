import { describe, expect, it } from 'vitest'
import { isRateLimitError, retryAfterMsFromError } from './rate-limit'

function apiError(status: number, headers?: Record<string, string>): Error {
  const err = new Error('boom') as Error & { status: number; headers?: Headers }
  err.status = status
  if (headers) err.headers = new Headers(headers)
  return err
}

describe('isRateLimitError', () => {
  it('recognizes a 429 status from any of the 3 SDK error shapes (Anthropic/OpenAI-family/Google all use .status)', () => {
    expect(isRateLimitError(apiError(429))).toBe(true)
  })

  it('is false for a different status code', () => {
    expect(isRateLimitError(apiError(500))).toBe(false)
    expect(isRateLimitError(apiError(401))).toBe(false)
  })

  it('is false for a plain Error with no status field at all (a genuine non-API failure)', () => {
    expect(isRateLimitError(new Error('network down'))).toBe(false)
  })

  it('is false for non-object/null values, not just a different shape', () => {
    expect(isRateLimitError(null)).toBe(false)
    expect(isRateLimitError(undefined)).toBe(false)
    expect(isRateLimitError('429')).toBe(false)
    expect(isRateLimitError(429)).toBe(false)
  })
})

describe('retryAfterMsFromError', () => {
  it('reads the exact retry-after-ms header when present, preferred over retry-after', () => {
    expect(retryAfterMsFromError(apiError(429, { 'retry-after-ms': '1500', 'retry-after': '30' }))).toBe(1500)
  })

  it('reads retry-after as whole seconds and converts to ms', () => {
    expect(retryAfterMsFromError(apiError(429, { 'retry-after': '30' }))).toBe(30_000)
  })

  it('reads retry-after as an HTTP-date and converts to a remaining-ms delta', () => {
    const future = new Date(Date.now() + 45_000).toUTCString()
    const ms = retryAfterMsFromError(apiError(429, { 'retry-after': future }))
    expect(ms).toBeGreaterThan(40_000)
    expect(ms).toBeLessThanOrEqual(45_000)
  })

  it('is undefined when there are no headers at all — the real shape of a Google/@google-genai ApiError, which has no headers field', () => {
    expect(retryAfterMsFromError(apiError(429))).toBeUndefined()
  })

  it('is undefined when headers exist but neither retry-after variant is present', () => {
    expect(retryAfterMsFromError(apiError(429, { 'x-request-id': 'abc' }))).toBeUndefined()
  })

  it('is undefined for a malformed retry-after value rather than throwing', () => {
    expect(retryAfterMsFromError(apiError(429, { 'retry-after': 'not-a-number-or-date' }))).toBeUndefined()
  })
})
