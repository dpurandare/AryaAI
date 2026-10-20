/**
 * TASKS #131: one Sachivji per user profile. Two instances would share one settings store, one database and one Python
 * environment (and could race while it is being created), and there is no reason to run two on a machine. The lock is keyed
 * by the app's userData folder, so a copy started with its own `--user-data-dir` (development, tests) is not blocked.
 */
export const SECOND_INSTANCE_TITLE = 'Sachivji is already running'
export const SECOND_INSTANCE_MESSAGE =
  'Another Sachivji window is already open. Close it before starting a new one.\n\nThis launch will now exit.'

interface InstanceApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: () => void): unknown
}

/**
 * Returns true when this is the only instance and startup should go on. Otherwise shows the message, then quits once the user
 * has dismissed it (`showError` may return a promise, because a native dialog cannot be shown before the app is ready); the
 * caller must not create a window or open the database. `onSecondLaunch` runs in the first instance when another launch is attempted
 * (used to bring its window to the front).
 */
export function ensureSingleInstance(
  app: InstanceApp,
  showError: (title: string, message: string) => void | Promise<void>,
  onSecondLaunch: () => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    void Promise.resolve(showError(SECOND_INSTANCE_TITLE, SECOND_INSTANCE_MESSAGE)).finally(() => app.quit())
    return false
  }
  app.on('second-instance', onSecondLaunch)
  return true
}
