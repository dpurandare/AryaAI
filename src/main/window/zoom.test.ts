import { describe, expect, it } from 'vitest'
import { nextZoomLevel, parseZoomLevel, zoomActionForInput, ZOOM_MAX, ZOOM_MIN, type ZoomKeyInput } from './zoom'

const key = (k: string, over: Partial<ZoomKeyInput> = {}): ZoomKeyInput => ({ type: 'keyDown', key: k, control: true, meta: false, alt: false, ...over })

describe('zoomActionForInput', () => {
  it('Ctrl with + or = zooms in, - or _ zooms out, 0 resets (Windows/Linux)', () => {
    expect(zoomActionForInput(key('='), false)).toBe('in')
    expect(zoomActionForInput(key('+'), false)).toBe('in')
    expect(zoomActionForInput(key('-'), false)).toBe('out')
    expect(zoomActionForInput(key('_'), false)).toBe('out')
    expect(zoomActionForInput(key('0'), false)).toBe('reset')
  })

  it('uses Cmd on macOS and ignores Ctrl there', () => {
    expect(zoomActionForInput(key('=', { control: false, meta: true }), true)).toBe('in')
    expect(zoomActionForInput(key('=', { control: true, meta: false }), true)).toBeNull()
    expect(zoomActionForInput(key('=', { control: true, meta: false }), false)).toBe('in')
    expect(zoomActionForInput(key('=', { control: false, meta: true }), false)).toBeNull()
  })

  it('ignores plain keys, other Ctrl combos, Alt combos and key-up', () => {
    expect(zoomActionForInput(key('=', { control: false }), false)).toBeNull()
    expect(zoomActionForInput(key('a'), false)).toBeNull()
    expect(zoomActionForInput(key('=', { alt: true }), false)).toBeNull()
    expect(zoomActionForInput(key('=', { type: 'keyUp' }), false)).toBeNull()
  })
})

describe('nextZoomLevel', () => {
  it('steps by half a level and resets to 0', () => {
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0.5, 'out')).toBe(0)
    expect(nextZoomLevel(2, 'reset')).toBe(0)
  })

  it('stops at the limits', () => {
    expect(nextZoomLevel(ZOOM_MAX, 'in')).toBe(ZOOM_MAX)
    expect(nextZoomLevel(ZOOM_MIN, 'out')).toBe(ZOOM_MIN)
  })
})

describe('parseZoomLevel', () => {
  it('reads a stored level and falls back to 100% for anything unusable', () => {
    expect(parseZoomLevel('1.5')).toBe(1.5)
    expect(parseZoomLevel(undefined)).toBe(0)
    expect(parseZoomLevel('')).toBe(0)
    expect(parseZoomLevel('abc')).toBe(0)
    expect(parseZoomLevel('99')).toBe(ZOOM_MAX)
    expect(parseZoomLevel('-99')).toBe(ZOOM_MIN)
  })
})
