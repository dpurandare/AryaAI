import { describe, expect, it, vi } from 'vitest'

let displays: Array<{ bounds: { x: number; y: number; width: number; height: number } }> = []

vi.mock('electron', () => ({
  screen: { getAllDisplays: () => displays }
}))

const { boundsAreOnScreen, DEFAULT_WINDOW_SIZE, parseWindowBounds, resolveInitialBounds } = await import('./bounds')

describe('parseWindowBounds', () => {
  it('reads a stored rectangle', () => {
    expect(parseWindowBounds(JSON.stringify({ x: 10, y: 20, width: 900, height: 700 }))).toEqual({ x: 10, y: 20, width: 900, height: 700 })
  })

  it('falls back to undefined for anything missing, malformed or non-finite', () => {
    expect(parseWindowBounds(undefined)).toBeUndefined()
    expect(parseWindowBounds('')).toBeUndefined()
    expect(parseWindowBounds('not json')).toBeUndefined()
    expect(parseWindowBounds(JSON.stringify({ x: 10, y: 20, width: 900 }))).toBeUndefined() // missing height
    expect(parseWindowBounds(JSON.stringify({ x: 'a', y: 20, width: 900, height: 700 }))).toBeUndefined()
    expect(parseWindowBounds(JSON.stringify({ x: 10, y: 20, width: 0, height: 700 }))).toBeUndefined()
    expect(parseWindowBounds(JSON.stringify({ x: 10, y: 20, width: Infinity, height: 700 }))).toBeUndefined()
  })
})

describe('boundsAreOnScreen', () => {
  const displayBounds = [{ x: 0, y: 0, width: 1920, height: 1080 }]

  it('true when the window overlaps a real display', () => {
    expect(boundsAreOnScreen({ x: 100, y: 100, width: 1200, height: 800 }, displayBounds)).toBe(true)
  })

  it('false when it is entirely off every display (e.g. a disconnected second monitor)', () => {
    expect(boundsAreOnScreen({ x: 3000, y: 100, width: 1200, height: 800 }, displayBounds)).toBe(false)
  })

  it('true as soon as any part overlaps, not just a full match', () => {
    expect(boundsAreOnScreen({ x: 1900, y: 1060, width: 1200, height: 800 }, displayBounds)).toBe(true)
  })
})

describe('resolveInitialBounds', () => {
  it('returns just the default size when nothing is stored', () => {
    expect(resolveInitialBounds(undefined)).toEqual(DEFAULT_WINDOW_SIZE)
  })

  it('returns the stored bounds when they land on a real display', () => {
    displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
    const stored = { x: 50, y: 50, width: 1000, height: 700 }
    expect(resolveInitialBounds(stored)).toEqual(stored)
  })

  it('falls back to the default size when the stored position is off every display', () => {
    displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
    expect(resolveInitialBounds({ x: 5000, y: 5000, width: 1000, height: 700 })).toEqual(DEFAULT_WINDOW_SIZE)
  })
})
