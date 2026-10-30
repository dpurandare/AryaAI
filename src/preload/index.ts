import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  type AppInfo,
  type SessionDto,
  type MessageDto,
  type ChatStreamEventPayload,
  type ToolConfirmRequestPayload,
  type LimitReachedRequestPayload,
  type DataConnectionDto,
  type SaveDataConnectionInput,
  type ApiConnectionDto,
  type SaveApiConnectionInput,
  type EmailConnectionDto,
  type ValidateEmailConnectionInput,
  type SaveEmailConnectionInput,
  type ContextWindowInfo,
  type ProviderDescriptor,
  type OllamaChatStatus,
  type WebSearchProviderDescriptor,
  type McpServerDto,
  type SaveMcpServerInput,
  type ToolDescriptor,
  type RoleToolsDto,
  type SessionUsageDto,
  type SessionExportResult,
  type AppUpdateAvailablePayload,
  type SearchHistoryStatusDto,
  type SessionTitleUpdatedPayload,
  type ToolValidateResult,
  type SecretStorageInfo,
  type RoleRosterDto,
  type SettingsExportPayload,
  type SettingsExportResult,
  type SettingsImportPreviewResult,
  type SettingsImportApplyResult
} from '@shared/ipc-contract'
import type { OllamaRuntimeState, RuntimeState } from '@shared/runtime'
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

  probeEmbeddingDimension: (providerId: string, model: string): Promise<number> =>
    ipcRenderer.invoke(IpcChannel.EmbeddingProbeDimension, providerId, model),

  listProviders: (): Promise<ProviderDescriptor[]> => ipcRenderer.invoke(IpcChannel.ProvidersList),
  listWebSearchProviders: (): Promise<WebSearchProviderDescriptor[]> =>
    ipcRenderer.invoke(IpcChannel.WebSearchProvidersList),
  setApiKey: (providerId: string, apiKey: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.ProvidersSetApiKey, providerId, apiKey),
  hasApiKey: (providerId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.ProvidersHasApiKey, providerId),
  getApiKeyPreview: (providerId: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.ProvidersGetApiKeyPreview, providerId),
  listModels: (providerId: string): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannel.ProvidersListModels, providerId),

  getSetting: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.SettingsGet, key),
  setSetting: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.SettingsSet, key, value),

  exportSettings: (): Promise<SettingsExportResult> => ipcRenderer.invoke(IpcChannel.SettingsExport),
  previewSettingsImport: (): Promise<SettingsImportPreviewResult> => ipcRenderer.invoke(IpcChannel.SettingsImportPreview),
  applySettingsImport: (payload: SettingsExportPayload): Promise<SettingsImportApplyResult> =>
    ipcRenderer.invoke(IpcChannel.SettingsImportApply, payload),

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

  listEmailConnections: (): Promise<EmailConnectionDto[]> => ipcRenderer.invoke(IpcChannel.EmailConnectionsList),
  saveEmailConnection: (input: SaveEmailConnectionInput): Promise<EmailConnectionDto> =>
    ipcRenderer.invoke(IpcChannel.EmailConnectionsSave, input),
  deleteEmailConnection: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.EmailConnectionsDelete, id),
  validateEmailConnection: (input: ValidateEmailConnectionInput): Promise<ToolValidateResult> =>
    ipcRenderer.invoke(IpcChannel.EmailConnectionsValidate, input),
  setDefaultEmailConnection: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.EmailConnectionsSetDefault, id),

  listMcpServers: (): Promise<McpServerDto[]> => ipcRenderer.invoke(IpcChannel.McpServersList),
  saveMcpServer: (input: SaveMcpServerInput): Promise<McpServerDto> =>
    ipcRenderer.invoke(IpcChannel.McpServersSave, input),
  deleteMcpServer: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.McpServersDelete, id),
  reconnectMcpServer: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.McpServersReconnect, id),

  getWorkspaceRoot: (): Promise<string> => ipcRenderer.invoke(IpcChannel.WorkspaceGetRoot),
  setWorkspaceRoot: (path: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.WorkspaceSetRoot, path),

  getRoles: (): Promise<RoleRosterDto> => ipcRenderer.invoke(IpcChannel.RolesGet),
  setRoleEnabled: (id: string, enabled: boolean): Promise<RoleRosterDto> => ipcRenderer.invoke(IpcChannel.RolesSetEnabled, id, enabled),
  openRolesFolder: (): Promise<void> => ipcRenderer.invoke(IpcChannel.RolesOpenFolder),
  createExampleRole: (): Promise<string> => ipcRenderer.invoke(IpcChannel.RolesCreateExample),

  getRuntimeState: (): Promise<RuntimeState | null> => ipcRenderer.invoke(IpcChannel.RuntimeGetState),
  ensureRuntime: (): Promise<RuntimeState> => ipcRenderer.invoke(IpcChannel.RuntimeEnsure),
  repairRuntime: (): Promise<RuntimeState> => ipcRenderer.invoke(IpcChannel.RuntimeRepair),
  setRuntimeEnabled: (enabled: boolean): Promise<RuntimeState> =>
    ipcRenderer.invoke(IpcChannel.RuntimeSetEnabled, enabled),
  onRuntimeStateChanged: (callback: (state: RuntimeState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: RuntimeState): void => callback(state)
    ipcRenderer.on(IpcChannel.RuntimeStateChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannel.RuntimeStateChanged, listener)
  },

  getOllamaRuntimeState: (): Promise<OllamaRuntimeState | null> => ipcRenderer.invoke(IpcChannel.OllamaGetState),
  ensureOllamaRuntime: (): Promise<OllamaRuntimeState> => ipcRenderer.invoke(IpcChannel.OllamaEnsure),
  checkOllamaChat: (): Promise<OllamaChatStatus> => ipcRenderer.invoke(IpcChannel.OllamaCheckChat),
  onOllamaRuntimeStateChanged: (callback: (state: OllamaRuntimeState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: OllamaRuntimeState): void => callback(state)
    ipcRenderer.on(IpcChannel.OllamaStateChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannel.OllamaStateChanged, listener)
  },

  getSearchHistoryStatus: (): Promise<SearchHistoryStatusDto> =>
    ipcRenderer.invoke(IpcChannel.SearchHistoryStatus),
  rebuildSearchHistoryIndex: (): Promise<void> => ipcRenderer.invoke(IpcChannel.SearchHistoryRebuildIndex),

  listTools: (): Promise<ToolDescriptor[]> => ipcRenderer.invoke(IpcChannel.ToolsList),
  listExternalFolders: (): Promise<string[]> => ipcRenderer.invoke(IpcChannel.ExternalFoldersList),
  removeExternalFolder: (folder: string): Promise<void> => ipcRenderer.invoke(IpcChannel.ExternalFoldersRemove, folder),
  listToolsByRole: (): Promise<RoleToolsDto[]> => ipcRenderer.invoke(IpcChannel.ToolsListByRole),

  getContextWindow: (): Promise<ContextWindowInfo | null> => ipcRenderer.invoke(IpcChannel.ContextWindowGet),

  sendChatMessage: (
    sessionId: string,
    text: string,
    forcedRole?: AgentRole | null
  ): Promise<{ streamId: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatSend, sessionId, text, forcedRole ?? null),
  cancelChat: (streamId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.ChatCancel, streamId),
  steerChat: (streamId: string, comment: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.ChatSteer, streamId, comment),

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

  onLimitReachedRequest: (callback: (payload: LimitReachedRequestPayload) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: LimitReachedRequestPayload): void =>
      callback(payload)
    ipcRenderer.on(IpcChannel.LimitReachedRequest, listener)
    return () => ipcRenderer.removeListener(IpcChannel.LimitReachedRequest, listener)
  },
  respondLimitReached: (requestId: string, continueWorking: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.LimitReachedRespond, requestId, continueWorking),

  getSecretStorageInfo: (): Promise<SecretStorageInfo> => ipcRenderer.invoke(IpcChannel.SecretStorageGetInfo),
  switchSecretStorageToFile: (): Promise<SecretStorageInfo> =>
    ipcRenderer.invoke(IpcChannel.SecretStorageSwitchToFile),

  /** TASKS #229: the full path of a file dropped onto the window (Electron no longer exposes `File.path`); '' when the item is not a file on disk. */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  /** Print-page-only: tells the hidden window's caller (see sessions/export.ts) the transcript has actually finished rendering and it's safe to call printToPDF. */
  notifyPrintReady: (): void => ipcRenderer.send(IpcChannel.PrintReady)
}

export type SachivApi = typeof api

contextBridge.exposeInMainWorld('sachiv', api)
