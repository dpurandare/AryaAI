import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  type AppInfo,
  type SessionDto,
  type MessageDto,
  type ChatStreamEventPayload
} from '@shared/ipc-contract'

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannel.AppGetInfo),

  listSessions: (): Promise<SessionDto[]> => ipcRenderer.invoke(IpcChannel.SessionsList),
  createSession: (title: string): Promise<SessionDto> =>
    ipcRenderer.invoke(IpcChannel.SessionsCreate, title),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.SessionsDelete, id),

  listMessages: (sessionId: string): Promise<MessageDto[]> =>
    ipcRenderer.invoke(IpcChannel.MessagesList, sessionId),

  setApiKey: (providerId: string, apiKey: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.ProvidersSetApiKey, providerId, apiKey),
  hasApiKey: (providerId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.ProvidersHasApiKey, providerId),
  listModels: (providerId: string): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannel.ProvidersListModels, providerId),

  getSetting: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.SettingsGet, key),
  setSetting: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.SettingsSet, key, value),

  sendChatMessage: (sessionId: string, text: string): Promise<{ streamId: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatSend, sessionId, text),

  onChatStreamEvent: (callback: (payload: ChatStreamEventPayload) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: ChatStreamEventPayload): void =>
      callback(payload)
    ipcRenderer.on(IpcChannel.ChatStreamEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannel.ChatStreamEvent, listener)
  }
}

export type SachivApi = typeof api

contextBridge.exposeInMainWorld('sachiv', api)
