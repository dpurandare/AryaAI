import type { WebContents } from 'electron'

/** Settings key holding the app's zoom level (Chromium's logarithmic scale: 0 = 100%, each +1 is 20% larger), persisted across launches. */
export const ZOOM_SETTING_KEY = 'zoomLevel'
export const ZOOM_STEP = 0.5
export const ZOOM_MIN = -3
export const ZOOM_MAX = 5

export type ZoomAction = 'in' | 'out' | 'reset'

export interface ZoomKeyInput {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
}

/**
 * Which zoom action a key press asks for, or null. Ctrl (Cmd on macOS) with `+`/`=` zooms in — both, because `+` needs Shift on most layouts
 * and people press either — `-`/`_` zooms out and `0` resets, like a browser or VS Code. Numpad keys arrive as the same characters.
 */
export function zoomActionForInput(input: ZoomKeyInput, isMac: boolean): ZoomAction | null {
  if (input.type !== 'keyDown' || input.alt) return null
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return null
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return null
}

export function nextZoomLevel(current: number, action: ZoomAction): number {
  if (action === 'reset') return 0
  const next = current + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
}

/** A stored level, tolerating a missing, non-numeric or out-of-range value (falls back to 100%). */
export function parseZoomLevel(raw: string | undefined): number {
  const n = Number(raw)
  if (raw === undefined || raw === '' || !Number.isFinite(n)) return 0
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n))
}

/**
 * Ctrl/Cmd + `+` / `-` / `0` zoom the whole app (text and layout), remembered between launches. Handled here rather than left to Electron's default
 * menu, whose "Zoom In" answers only Ctrl+Shift+= and is not present at all where the menu bar is hidden.
 */
export function attachZoomShortcuts(
  webContents: WebContents,
  store: { get(): string | undefined; set(value: string): void },
  isMac: boolean
): void {
  webContents.on('dom-ready', () => webContents.setZoomLevel(parseZoomLevel(store.get())))
  webContents.on('before-input-event', (event, input) => {
    const action = zoomActionForInput(input, isMac)
    if (!action) return
    event.preventDefault()
    const next = nextZoomLevel(webContents.getZoomLevel(), action)
    webContents.setZoomLevel(next)
    store.set(String(next))
  })
}
