export type ThemeMode = 'light' | 'dark' | 'system'

const THEME_SETTING_KEY = 'themeMode'
const DEFAULT_THEME_MODE: ThemeMode = 'system'

let currentMode: ThemeMode = DEFAULT_THEME_MODE
let systemQuery: MediaQueryList | undefined

function resolvedFromSystem(): 'light' | 'dark' {
  return systemQuery?.matches ? 'light' : 'dark'
}

function apply(): void {
  const resolved = currentMode === 'system' ? resolvedFromSystem() : currentMode
  document.documentElement.setAttribute('data-theme', resolved)
}

function onSystemChange(): void {
  // Only re-apply while "system" is actually selected — an explicit
  // light/dark choice must not get silently overridden by an OS change.
  if (currentMode === 'system') apply()
}

/**
 * Reads the persisted preference and starts tracking the OS-level scheme
 * live. Call once, before the app mounts (see main.ts), so the correct
 * theme is already on `<html>` for the very first paint instead of
 * flashing the wrong one.
 */
export async function initTheme(): Promise<ThemeMode> {
  systemQuery = window.matchMedia('(prefers-color-scheme: light)')
  systemQuery.addEventListener('change', onSystemChange)
  const stored = await window.sachiv.getSetting(THEME_SETTING_KEY)
  currentMode = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_THEME_MODE
  apply()
  return currentMode
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  currentMode = mode
  apply()
  await window.sachiv.setSetting(THEME_SETTING_KEY, mode)
}

export function getThemeMode(): ThemeMode {
  return currentMode
}
