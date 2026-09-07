import { app, ipcMain } from 'electron'
import { IpcChannel, type AppInfo } from '@shared/ipc-contract'

/**
 * Central place where every ipcMain.handle/on channel is registered.
 * As agents/providers/tools land, each module registers its own channels
 * here rather than main/index.ts growing a pile of handlers.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.AppGetInfo, (): AppInfo => ({
    name: 'Sachiv',
    version: app.getVersion(),
    platform: process.platform
  }))
}
