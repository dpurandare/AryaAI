import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  type AppInfo,
  type SessionDto,
  type MessageDto,
  type ChatStreamEventPayload,
  type ToolConfirmRequestPayload,
  type DataConnectionDto,
  type SaveDataConnectionInput,
  type ProviderDescriptor,
  type McpServerDto,
  type SaveMcpServerInput
} from '@shared/ipc-contract'
import type { AgentRole } from '@shared/agents'

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannel.AppGetInfo),

  listSessions: (): Promise<SessionDto[]> => ipcRenderer.invoke(IpcChannel.SessionsList),
  createSession: (title: string): Promise<SessionDto> =>
    ipcRenderer.invoke(IpcChannel.SessionsCreate, title),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.SessionsDelete, id),

  listMessages: (sessionId: string): Promise<MessageDto[]> =>
    ipcRenderer.invoke(IpcChannel.MessagesList, sessionId),

  listProviders: (): Promise<ProviderDescriptor[]> => ipcRenderer.invoke(IpcChannel.ProvidersList),
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

  listDataConnections: (): Promise<DataConnectionDto[]> =>
    ipcRenderer.invoke(IpcChannel.DataConnectionsList),
  saveDataConnection: (input: SaveDataConnectionInput): Promise<DataConnectionDto> =>
    ipcRenderer.invoke(IpcChannel.DataConnectionsSave, input),
  deleteDataConnection: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.DataConnectionsDelete, id),

  listMcpServers: (): Promise<McpServerDto[]> => ipcRenderer.invoke(IpcChannel.McpServersList),
  saveMcpServer: (input: SaveMcpServerInput): Promise<McpServerDto> =>
    ipcRenderer.invoke(IpcChannel.McpServersSave, input),
  deleteMcpServer: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.McpServersDelete, id),
  reconnectMcpServer: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.McpServersReconnect, id),

  sendChatMessage: (
    sessionId: string,
    text: string,
    forcedRole?: AgentRole | null
  ): Promise<{ streamId: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatSend, sessionId, text, forcedRole ?? null),

  onChatStreamEvent: (callback: (payload: ChatStreamEventPayload) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: ChatStreamEventPayload): void =>
      callback(payload)
    ipcRenderer.on(IpcChannel.ChatStreamEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannel.ChatStreamEvent, listener)
  },

  onToolConfirmRequest: (callback: (payload: ToolConfirmRequestPayload) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: ToolConfirmRequestPayload): void =>
      callback(payload)
    ipcRenderer.on(IpcChannel.ToolConfirmRequest, listener)
    return () => ipcRenderer.removeListener(IpcChannel.ToolConfirmRequest, listener)
  },
  respondToolConfirm: (
    toolUseId: string,
    approved: boolean,
    input?: Record<string, unknown>
  ): Promise<void> => ipcRenderer.invoke(IpcChannel.ToolConfirmRespond, toolUseId, approved, input)
}

export type SachivApi = typeof api

contextBridge.exposeInMainWorld('sachiv', api)
