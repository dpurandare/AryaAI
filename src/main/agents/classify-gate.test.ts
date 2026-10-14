import { describe, expect, it } from 'vitest'
import { evaluateClassifyGate, shouldSampleForCalibration } from './classify-gate'

describe('evaluateClassifyGate with a knowledge server connected (found live in 13.4.3: an axios how-to was answered from memory)', () => {
  const withServers = { knowledgeServers: true }

  it('no longer skips a short question, which may be one the server covers', () => {
    expect(evaluateClassifyGate('How do I set a default request timeout in axios?')).toBe('skip')
    expect(evaluateClassifyGate('How do I set a default request timeout in axios?', withServers)).toBe('run')
    expect(evaluateClassifyGate('What is a mutex?', withServers)).toBe('run')
  })

  it('still skips a greeting or a thank-you', () => {
    expect(evaluateClassifyGate('hi', withServers)).toBe('skip')
    expect(evaluateClassifyGate('thanks!', withServers)).toBe('skip')
  })
})

describe('evaluateClassifyGate', () => {
  it('skips an obviously simple, short greeting', () => {
    expect(evaluateClassifyGate('hi')).toBe('skip')
    expect(evaluateClassifyGate('thanks!')).toBe('skip')
  })

  it('skips a short single-clause factual question', () => {
    expect(evaluateClassifyGate("What's the capital of France?")).toBe('skip')
  })

  it('runs the real classifier for anything long enough to plausibly bundle multiple asks', () => {
    const long = 'Please summarize the quarterly report '.repeat(3)
    expect(long.length).toBeGreaterThan(50)
    expect(evaluateClassifyGate(long)).toBe('run')
  })

  it('runs the real classifier when a compound connector word is present', () => {
    expect(evaluateClassifyGate('find X and save it')).toBe('run')
    expect(evaluateClassifyGate('look this up then email it')).toBe('run')
    expect(evaluateClassifyGate('check the price also tell me the tax')).toBe('run')
    expect(evaluateClassifyGate('read the file after you clone it')).toBe('run')
  })

  it('runs the real classifier on a semicolon- or newline-joined message', () => {
    expect(evaluateClassifyGate('do X; do Y')).toBe('run')
    expect(evaluateClassifyGate('do X\ndo Y')).toBe('run')
  })

  it('runs the real classifier when more than one sentence is bundled in, even with no connector word', () => {
    expect(evaluateClassifyGate("What's the weather? Book a table.")).toBe('run')
  })

  it('runs the real classifier on empty/whitespace-only input rather than guessing', () => {
    expect(evaluateClassifyGate('')).toBe('run')
    expect(evaluateClassifyGate('   ')).toBe('run')
  })

  it('a single-clause message that happens to contain "and" as a false-positive-prone substring is still correctly caught by the word-boundary match', () => {
    // "android", "sandwich" etc. must not trigger the connector-word regex
    // via a naive substring match — \b keeps this to the real word "and".
    expect(evaluateClassifyGate('is my android up to date')).toBe('skip')
  })
})

describe('shouldSampleForCalibration', () => {
  it('is deterministic given an injected random source, for testability', () => {
    expect(shouldSampleForCalibration(() => 0)).toBe(true)
    expect(shouldSampleForCalibration(() => 0.99)).toBe(false)
  })
})
