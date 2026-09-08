import { describe, expect, it } from 'vitest'
import { contextWindowFor, estimateCost, pricePerMillionTokens } from './model-metadata'

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
