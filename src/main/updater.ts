import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IpcChannel, type AppUpdateAvailablePayload } from '@shared/ipc-contract'

const RELEASE_BASE_URL = 'https://github.com/dpurandare/AryaAI/releases/tag'

/**
 * Checks the GitHub Releases feed once for a newer version and tells the
 * renderer if one exists. Never downloads or installs anything — this app
 * isn't code-signed yet (TASKS.md #63-65), and an unsigned build can't
 * reliably self-replace, especially on macOS, so silent auto-update stays
 * off until real signing exists.
 */
export function initUpdater(window: BrowserWindow): void {
  autoUpdater.autoDownload = false

  autoUpdater.on('update-available', (info) => {
    const payload: AppUpdateAvailablePayload = {
      version: info.version,
      releaseUrl: `${RELEASE_BASE_URL}/v${info.version}`
    }
    window.webContents.send(IpcChannel.AppUpdateAvailable, payload)
  })

  autoUpdater.on('error', (err) => {
    console.error('Update check failed:', err)
  })

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    console.error('Update check failed:', err)
  })
}
