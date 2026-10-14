import { describe, expect, it } from 'vitest'
import { contextFraction, contextLabel, contextWarning, formatCount } from './context-meter'

describe('context meter', () => {
  it('formats counts', () => {
    expect(formatCount(950)).toBe('950')
    expect(formatCount(38_000)).toBe('38.0K')
    expect(formatCount(1_100_000)).toBe('1.1M')
  })

  it('labels the context in use against the window, with a dash before anything is measured and ~ for an estimated window', () => {
    expect(contextLabel(38_000, 200_000, false)).toBe('ctx 38.0K / 200.0K')
    expect(contextLabel(null, 200_000, false)).toBe('ctx – / 200.0K')
    expect(contextLabel(5_000, 4_096, true)).toBe('ctx 5.0K / ~4.1K')
  })

  it('warns at 80% of the window for the context only - a large session total alone does not', () => {
    expect(contextWarning(160_000, 200_000)).toBe(true)
    expect(contextWarning(159_999, 200_000)).toBe(false)
    expect(contextWarning(null, 200_000)).toBe(false)
    expect(contextFraction(10, 0)).toBe(0)
  })
})
