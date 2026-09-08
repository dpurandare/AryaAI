import type { ContentBlock, StreamEvent } from './protocol'

/**
 * Single source of truth for the channel names and payload types crossing
 * the main <-> preload <-> renderer boundary.
 */
export const IpcChannel = {
  AppGetInfo: 'app:get-info',

  SessionsList: 'sessions:list',
  SessionsCreate: 'sessions:create',
  SessionsDelete: 'sessions:delete',

  MessagesList: 'messages:list',

  ProvidersList: 'providers:list',
  ProvidersSetApiKey: 'providers:set-api-key',
  ProvidersHasApiKey: 'providers:has-api-key',
  ProvidersListModels: 'providers:list-models',

  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',

  DataConnectionsList: 'data-connections:list',
  DataConnectionsSave: 'data-connections:save',
  DataConnectionsDelete: 'data-connections:delete',

  McpServersList: 'mcp-servers:list',
  McpServersSave: 'mcp-servers:save',
  McpServersDelete: 'mcp-servers:delete',
  McpServersReconnect: 'mcp-servers:reconnect',

  ChatSend: 'chat:send',
  ChatStreamEvent: 'chat:stream-event',

  ToolConfirmRequest: 'tools:confirm-request',
  ToolConfirmRespond: 'tools:confirm-respond'
} as const

/**
 * A provider's public shape, as seen over IPC — the main-process registry
 * (`src/main/providers/registry.ts`) is the actual source of truth; the
 * renderer fetches this list at startup via `ProvidersList` instead of
 * hardcoding it, so adding a provider needs no renderer change.
 */
export interface ProviderDescriptor {
  id: string
  displayName: string
  requiresApiKey: boolean
}

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
}

export interface SessionDto {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface MessageDto {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  createdAt: number
}

export interface ChatStreamEventPayload {
  streamId: string
  sessionId: string
  event: StreamEvent
}

export interface ToolConfirmRequestPayload {
  streamId: string
  sessionId: string
  toolUseId: string
  name: string
  input: Record<string, unknown>
  description: string
}

export type DbEngine = 'sqlite' | 'postgres'

/** Connection metadata only — never carries a password. */
export interface DataConnectionDto {
  id: string
  name: string
  engine: DbEngine
  filePath?: string
  host?: string
  port?: number
  database?: string
  username?: string
}

/** `id` omitted creates a new connection; `password` omitted on an edit leaves the stored one unchanged. */
export interface SaveDataConnectionInput {
  id?: string
  name: string
  engine: DbEngine
  filePath?: string
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string
}

export type McpTransport = 'stdio' | 'http'
export type McpServerStatus = 'connecting' | 'connected' | 'error'

/** Config metadata plus live connection state — never carries a bearer token. */
export interface McpServerDto {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  hasToken?: boolean
  status: McpServerStatus
  error?: string
  toolCount: number
}

/** `id` omitted creates a new server; `token` omitted on an edit leaves the stored one unchanged. */
export interface SaveMcpServerInput {
  id?: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  token?: string
}
