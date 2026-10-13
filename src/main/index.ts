import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/register'
import { setDbPath } from './db'
import { getSetting, setSetting } from './db/settings'
import { attachZoomShortcuts, ZOOM_SETTING_KEY } from './window/zoom'
import { attachBoundsPersistence, parseWindowBounds, resolveInitialBounds, WINDOW_BOUNDS_SETTING_KEY } from './window/bounds'
import { attachSpellcheckContextMenu } from './window/context-menu'
import { initUpdater } from './updater'

// On GNOME/Wayland, Electron auto-selects the native Wayland backend, whose
// window taskbar/dash icon comes from a .desktop file matched to the
// window's Wayland app_id — not from the `icon:` BrowserWindow option below.
// An unpackaged dev build has no such .desktop file, so the icon falls back
// to Electron's generic one. Forcing XWayland in dev restores the standard
// X11 _NET_WM_ICON path, which mutter does honor and which already works
// correctly via the `icon:` option. The packaged app ships a real .desktop
// file (via electron-builder's linux target) and isn't affected either way.
if (is.dev && process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11')
}

const devIconPath = join(__dirname, '../../build/icon.png')

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    ...resolveInitialBounds(parseWindowBounds(getSetting(WINDOW_BOUNDS_SETTING_KEY))),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#171717',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    ...(is.dev ? { icon: devIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  attachBoundsPersistence(mainWindow, {
    get: () => getSetting(WINDOW_BOUNDS_SETTING_KEY),
    set: (value) => setSetting(WINDOW_BOUNDS_SETTING_KEY, value)
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  attachZoomShortcuts(
    mainWindow.webContents,
    { get: () => getSetting(ZOOM_SETTING_KEY), set: (value) => setSetting(ZOOM_SETTING_KEY, value) },
    process.platform === 'darwin'
  )

  attachSpellcheckContextMenu(mainWindow.webContents)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// Prevents the app from sharing Electron's generic default userData
// directory (~/.../Electron) with other unpackaged Electron apps on the
// same machine — each app must have its own isolated data/credentials.
// Renaming this (Sachiv -> Sachivji) changes the userData folder name too —
// existing local sessions/keys under the old name won't be picked up, a
// fresh empty one gets created under the new name instead.
app.setName('Sachivji')

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.sachiv.app')

  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(devIconPath)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setDbPath(join(app.getPath('userData'), 'sachiv.db'))
  registerIpcHandlers()
  const mainWindow = createMainWindow()

  if (!is.dev) {
    initUpdater(mainWindow)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
