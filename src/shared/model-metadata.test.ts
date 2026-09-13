import { describe, expect, it } from 'vitest'
import { contextWindowFor, estimateCost, maxOutputTokensFor, pricePerMillionTokens } from './model-metadata'

describe('contextWindowFor', () => {
  it('matches known model prefixes', () => {
    expect(contextWindowFor('claude-sonnet-5')).toEqual({ tokens: 200_000, isEstimate: false })
    expect(contextWindowFor('gemini-flash-latest')).toEqual({ tokens: 1_048_576, isEstimate: false })
    expect(contextWindowFor('gpt-4o')).toEqual({ tokens: 128_000, isEstimate: false })
  })

  it('falls back to a generic estimate for an unrecognized model', () => {
    const result = contextWindowFor('gpt-oss:20b')
    expect(result.isEstimate).toBe(true)
    expect(result.tokens).toBeGreaterThan(0)
  })

  it('uses a conservative 4096 fallback for a local model with no live reading, not a generous guess', () => {
    // Deliberately small, not the unrecognized-cloud-model fallback (8192) —
    // see model-metadata.ts's DEFAULT_LOCAL_CONTEXT_WINDOW comment. A larger
    // guess here previously let a prompt reach Ollama's real, smaller
    // runtime limit and get silently truncated mid-turn with zero output.
    expect(contextWindowFor('gpt-oss:20b')).toEqual({ tokens: 4_096, isEstimate: true })
    expect(contextWindowFor('qwen3.6:latest')).toEqual({ tokens: 4_096, isEstimate: true })
  })
})

describe('maxOutputTokensFor', () => {
  it('matches known model prefixes with their real, confirmed per-call ceilings', () => {
    // Confirmed live against each provider's own current docs, 2026-09-13 —
    // see orchestrator.ts's resolveMaxOutputTokens doc comment.
    expect(maxOutputTokensFor('claude-sonnet-5')).toEqual({ tokens: 128_000, isEstimate: false })
    expect(maxOutputTokensFor('claude-opus-5')).toEqual({ tokens: 128_000, isEstimate: false })
    expect(maxOutputTokensFor('claude-haiku-4-5')).toEqual({ tokens: 64_000, isEstimate: false })
    expect(maxOutputTokensFor('gpt-4o')).toEqual({ tokens: 16_384, isEstimate: false })
    expect(maxOutputTokensFor('gemini-flash-latest')).toEqual({ tokens: 64_000, isEstimate: false })
  })

  it('gives reasoning models (o1/o3) a generous ceiling, not the flat cloud default', () => {
    // These spend hidden chain-of-thought tokens against this same budget
    // before any visible output — the identical failure class found live
    // against gpt-oss, just on a cloud provider (see orchestrator.ts).
    const o1 = maxOutputTokensFor('o1-preview')
    const o3 = maxOutputTokensFor('o3-mini')
    expect(o1.tokens).toBeGreaterThan(4_096)
    expect(o3.tokens).toBeGreaterThan(4_096)
  })

  it('falls back to a conservative 4096 for an unrecognized cloud model, not a guess', () => {
    expect(maxOutputTokensFor('some-future-model')).toEqual({ tokens: 4_096, isEstimate: true })
  })

  it('gives a local (Ollama-shaped) model a generous default ceiling — no real per-call rejection risk to guard against', () => {
    const result = maxOutputTokensFor('gpt-oss:20b')
    expect(result.isEstimate).toBe(true)
    expect(result.tokens).toBeGreaterThan(4_096)
  })
})

describe('pricePerMillionTokens', () => {
  it('resolves known cloud models', () => {
    expect(pricePerMillionTokens('claude-sonnet-5')).toEqual({ input: 3, output: 15 })
  })

  it('treats "name:tag" ids as free local (Ollama) models', () => {
    expect(pricePerMillionTokens('gpt-oss:20b')).toEqual({ input: 0, output: 0 })
  })

  it('returns undefined for an unrecognized cloud-shaped model rather than guessing', () => {
    expect(pricePerMillionTokens('some-future-model')).toBeUndefined()
  })
})

describe('estimateCost', () => {
  it('computes a real cost for a known model', () => {
    const cost = estimateCost('claude-sonnet-5', 1_000_000, 1_000_000)
    expect(cost).toBe(18)
  })

  it('is free for a local model', () => {
    expect(estimateCost('gpt-oss:20b', 1_000_000, 1_000_000)).toBe(0)
  })

  it('is undefined when pricing is unknown', () => {
    expect(estimateCost('some-future-model', 100, 100)).toBeUndefined()
  })
})
