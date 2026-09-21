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
  type ApiConnectionDto,
  type SaveApiConnectionInput,
  type ContextWindowInfo,
  type ProviderDescriptor,
  type McpServerDto,
  type SaveMcpServerInput,
  type ToolDescriptor,
  type SessionUsageDto,
  type SessionExportResult,
  type AppUpdateAvailablePayload,
  type SearchHistoryStatusDto,
  type SessionTitleUpdatedPayload,
  type ToolValidateResult,
  type SecretStorageInfo
} from '@shared/ipc-contract'
import type { AgentRole } from '@shared/agents'

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannel.AppGetInfo),
  onUpdateAvailable: (callback: (payload: AppUpdateAvailablePayload) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: AppUpdateAvailablePayload): void =>
      callback(payload)
    ipcRenderer.on(IpcChannel.AppUpdateAvailable, listener)
    return () => ipcRenderer.removeListener(IpcChannel.AppUpdateAvailable, listener)
  },

  listSessions: (): Promise<SessionDto[]> => ipcRenderer.invoke(IpcChannel.SessionsList),
  createSession: (title: string): Promise<SessionDto> =>
    ipcRenderer.invoke(IpcChannel.SessionsCreate, title),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.SessionsDelete, id),
  onSessionTitleUpdated: (callback: (payload: SessionTitleUpdatedPayload) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: SessionTitleUpdatedPayload): void =>
      callback(payload)
    ipcRenderer.on(IpcChannel.SessionTitleUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannel.SessionTitleUpdated, listener)
  },
  exportSession: (id: string): Promise<SessionExportResult> =>
    ipcRenderer.invoke(IpcChannel.SessionsExport, id),

  listMessages: (sessionId: string): Promise<MessageDto[]> =>
    ipcRenderer.invoke(IpcChannel.MessagesList, sessionId),
  getSessionUsage: (sessionId: string): Promise<SessionUsageDto> =>
    ipcRenderer.invoke(IpcChannel.SessionsGetUsage, sessionId),

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

  listApiConnections: (): Promise<ApiConnectionDto[]> => ipcRenderer.invoke(IpcChannel.ApiConnectionsList),
  saveApiConnection: (input: SaveApiConnectionInput): Promise<ApiConnectionDto> =>
    ipcRenderer.invoke(IpcChannel.ApiConnectionsSave, input),
  deleteApiConnection: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.ApiConnectionsDelete, id),

  listMcpServers: (): Promise<McpServerDto[]> => ipcRenderer.invoke(IpcChannel.McpServersList),
  saveMcpServer: (input: SaveMcpServerInput): Promise<McpServerDto> =>
    ipcRenderer.invoke(IpcChannel.McpServersSave, input),
  deleteMcpServer: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.McpServersDelete, id),
  reconnectMcpServer: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.McpServersReconnect, id),

  getWorkspaceRoot: (): Promise<string> => ipcRenderer.invoke(IpcChannel.WorkspaceGetRoot),
  setWorkspaceRoot: (path: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.WorkspaceSetRoot, path),

  getSearchHistoryStatus: (): Promise<SearchHistoryStatusDto> =>
    ipcRenderer.invoke(IpcChannel.SearchHistoryStatus),
  rebuildSearchHistoryIndex: (): Promise<void> => ipcRenderer.invoke(IpcChannel.SearchHistoryRebuildIndex),

  listTools: (): Promise<ToolDescriptor[]> => ipcRenderer.invoke(IpcChannel.ToolsList),

  getContextWindow: (): Promise<ContextWindowInfo | null> => ipcRenderer.invoke(IpcChannel.ContextWindowGet),

  sendChatMessage: (
    sessionId: string,
    text: string,
    forcedRole?: AgentRole | null
  ): Promise<{ streamId: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatSend, sessionId, text, forcedRole ?? null),
  cancelChat: (streamId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.ChatCancel, streamId),

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
  ): Promise<void> => ipcRenderer.invoke(IpcChannel.ToolConfirmRespond, toolUseId, approved, input),
  validateToolInput: (name: string, input: Record<string, unknown>): Promise<ToolValidateResult> =>
    ipcRenderer.invoke(IpcChannel.ToolValidateInput, name, input),

  getSecretStorageInfo: (): Promise<SecretStorageInfo> => ipcRenderer.invoke(IpcChannel.SecretStorageGetInfo),
  switchSecretStorageToFile: (): Promise<SecretStorageInfo> =>
    ipcRenderer.invoke(IpcChannel.SecretStorageSwitchToFile),

  /** Print-page-only: tells the hidden window's caller (see sessions/export.ts) the transcript has actually finished rendering and it's safe to call printToPDF. */
  notifyPrintReady: (): void => ipcRenderer.send(IpcChannel.PrintReady)
}

export type SachivApi = typeof api

contextBridge.exposeInMainWorld('sachiv', api)
