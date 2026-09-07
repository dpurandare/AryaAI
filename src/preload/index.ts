import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type AppInfo } from '@shared/ipc-contract'

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannel.AppGetInfo)
}

export type SachivApi = typeof api

contextBridge.exposeInMainWorld('sachiv', api)
