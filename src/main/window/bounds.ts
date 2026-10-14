import type { BrowserWindow, Rectangle } from 'electron'
import { screen } from 'electron'

/** Settings key holding the last window position/size, persisted across launches (TASKS.md #199). */
export const WINDOW_BOUNDS_SETTING_KEY = 'windowBounds'

/** No `x`/`y` here on purpose: there is no stored position yet on first launch, and the BrowserWindow constructor's own default (center of the primary display) is better than forcing a corner. */
export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 }
export type InitialWindowBounds = Rectangle | typeof DEFAULT_WINDOW_SIZE

/** A stored bounds string, tolerating missing/malformed JSON or non-finite numbers (falls back to the default size, letting the OS place it). */
export function parseWindowBounds(raw: string | undefined): Rectangle | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<Rectangle>
    const { x, y, width, height } = parsed
    const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return undefined
    if (width <= 0 || height <= 0) return undefined
    return { x, y, width, height }
  } catch {
    return undefined
  }
}

/**
 * A saved position is only usable if at least part of the window would land on a display that still
 * exists — otherwise a since-disconnected second monitor (or a changed resolution) would strand the
 * window off-screen with no way back to it short of editing the database by hand.
 */
export function boundsAreOnScreen(bounds: Rectangle, displays: Rectangle[]): boolean {
  return displays.some((d) => bounds.x < d.x + d.width && bounds.x + bounds.width > d.x && bounds.y < d.y + d.height && bounds.y + bounds.height > d.y)
}

/**
 * Remembers the window's position and size between launches. Call before `show()`; a debounced
 * 'resize'/'move' listener (plus 'close', to catch the last move before quit) keeps the stored value
 * current without writing to the database on every intermediate drag event.
 */
export function attachBoundsPersistence(window: BrowserWindow, store: { get(): string | undefined; set(value: string): void }): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!window.isDestroyed()) store.set(JSON.stringify(window.getBounds()))
    }, 500)
  }
  window.on('resize', save)
  window.on('move', save)
  window.on('close', () => {
    clearTimeout(timer)
    if (!window.isDestroyed()) store.set(JSON.stringify(window.getBounds()))
  })
}

/** The bounds to actually open the window with: the stored ones if they're still on a real display, otherwise just the default size (no position — let Electron place it, same as today's first-launch behavior). */
export function resolveInitialBounds(stored: Rectangle | undefined): InitialWindowBounds {
  if (!stored) return DEFAULT_WINDOW_SIZE
  const displays = screen.getAllDisplays().map((d) => d.bounds)
  return boundsAreOnScreen(stored, displays) ? stored : DEFAULT_WINDOW_SIZE
}
