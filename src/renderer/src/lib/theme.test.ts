// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * jsdom implements neither `window.matchMedia` nor the app's own
 * `window.sachiv` preload bridge — both are faked here. The media query
 * fake keeps a live `matches` flag and hands back the registered listener
 * so tests can simulate an OS-level scheme change without a real browser.
 */
function installMatchMediaStub(initialMatches: boolean): {
  setMatches: (value: boolean) => void
  listenerCount: () => number
} {
  let matches = initialMatches
  const listeners = new Set<() => void>()
  const mql = {
    get matches() {
      return matches
    },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener)
  }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql))
  return {
    setMatches: (value: boolean) => {
      matches = value
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size
  }
}

function installSachivStub(storedValue: string | null): {
  setSetting: ReturnType<typeof vi.fn>
} {
  const setSetting = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('sachiv', {
    getSetting: vi.fn().mockResolvedValue(storedValue),
    setSetting
  })
  return { setSetting }
}

describe('theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('applies an explicit stored preference regardless of the OS scheme', async () => {
    installMatchMediaStub(false) // OS says dark
    installSachivStub('light')
    const { initTheme } = await import('./theme')

    const mode = await initTheme()

    expect(mode).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('defaults to "system" when nothing is stored, resolved from the OS scheme', async () => {
    installMatchMediaStub(true) // OS says light
    installSachivStub(null)
    const { initTheme } = await import('./theme')

    const mode = await initTheme()

    expect(mode).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('ignores an unrecognized stored value and falls back to "system"', async () => {
    installMatchMediaStub(false)
    installSachivStub('sepia')
    const { initTheme } = await import('./theme')

    expect(await initTheme()).toBe('system')
  })

  it('setThemeMode applies immediately and persists the choice', async () => {
    installMatchMediaStub(true)
    const { setSetting } = installSachivStub('system')
    const { initTheme, setThemeMode } = await import('./theme')
    await initTheme()

    await setThemeMode('dark')

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(setSetting).toHaveBeenCalledWith('themeMode', 'dark')
  })

  it('a live OS scheme change re-resolves the theme while mode is "system"', async () => {
    const media = installMatchMediaStub(false) // starts dark
    installSachivStub('system')
    const { initTheme } = await import('./theme')
    await initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    media.setMatches(true) // OS flips to light

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('an OS scheme change is ignored once the user picks an explicit theme', async () => {
    const media = installMatchMediaStub(false)
    installSachivStub('system')
    const { initTheme, setThemeMode } = await import('./theme')
    await initTheme()
    await setThemeMode('dark')

    media.setMatches(true) // OS flips to light, but the explicit choice should stick

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
