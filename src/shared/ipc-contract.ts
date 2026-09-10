import type { ContentBlock, StreamEvent } from './protocol'

/**
 * Single source of truth for the channel names and payload types crossing
 * the main <-> preload <-> renderer boundary.
 */
export const IpcChannel = {
  AppGetInfo: 'app:get-info',
  AppUpdateAvailable: 'app:update-available',

  SessionsList: 'sessions:list',
  SessionsCreate: 'sessions:create',
  SessionsDelete: 'sessions:delete',
  SessionsExport: 'sessions:export',

  MessagesList: 'messages:list',
  SessionsGetUsage: 'sessions:get-usage',

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

  WorkspaceGetRoot: 'workspace:get-root',
  WorkspaceSetRoot: 'workspace:set-root',

  ToolsList: 'tools:list',

  ChatSend: 'chat:send',
  ChatCancel: 'chat:cancel',
  ChatStreamEvent: 'chat:stream-event',

  ToolConfirmRequest: 'tools:confirm-request',
  ToolConfirmRespond: 'tools:confirm-respond',

  SearchHistoryStatus: 'search-history:status',
  SearchHistoryRebuildIndex: 'search-history:rebuild-index',

  SessionTitleUpdated: 'sessions:title-updated'
} as const

/** What every new session starts as — shared so the renderer (creating sessions) and the main process (deciding whether it's still safe to auto-title one) agree on the exact string. */
export const DEFAULT_SESSION_TITLE = 'New Chat'

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
  /** Whether this provider can be picked for the separate embedding-provider role (Settings > Search history) — independent of the chat provider. */
  supportsEmbeddings: boolean
}

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
  userName: string
}

/** Pushed from main to renderer when electron-updater finds a newer release. */
export interface AppUpdateAvailablePayload {
  version: string
  releaseUrl: string
}

export interface SearchHistoryStatusDto {
  providerId: string
  model: string
  state: 'empty' | 'ready' | 'needs-rebuild'
  indexed: number
  total: number
}

export interface SessionDto {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface SessionExportResult {
  cancelled: boolean
  path?: string
}

/** Pushed from main to renderer once a session's title is auto-generated from its first message — see db/sessions.ts's titleFromMessage. */
export interface SessionTitleUpdatedPayload {
  sessionId: string
  title: string
}

export interface MessageDto {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  createdAt: number
}

export interface SessionUsageDto {
  inputTokens: number
  outputTokens: number
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

export type SavedQueryParamType = 'string' | 'number'

export interface SavedQueryParam {
  name: string
  type: SavedQueryParamType
}

/**
 * A curated, parametric SQL template — the point is to let the Data agent
 * reuse a named, pre-written query instead of re-deriving the same SQL from
 * scratch on every question that needs it, the same role db_tools.py's
 * canned KPI helpers play in the reference EnergyAIProto2 app (hardcoded
 * Python there, since that app's schema is fixed at build time; here the
 * Data agent authors these itself at runtime instead, via db_save_query,
 * since a connection's schema isn't known until a user adds one). `sql`
 * uses `:name` placeholders (see main/tools/db/param-binding.ts); `mutates`
 * is computed once, from the SQL text, when the query is saved — not per
 * call, since the SQL shape itself (only the bound values vary) is fixed
 * once saved.
 *
 * Stored *nested inside* its connection (DataConnectionDto.savedQueries)
 * rather than as an independent collection — deliberately not surfaced in
 * Settings at all; the Data agent is the only author, via the db_save_query
 * tool (mutates: true, so a human still approves each one via the normal
 * confirmation dialog).
 */
export interface SavedQueryDto {
  id: string
  connectionId: string
  name: string
  description: string
  sql: string
  params: SavedQueryParam[]
  mutates: boolean
}

/**
 * A cheap, table-names-only hint of what's inside a connection — NOT a
 * substitute for db_introspect_schema (no columns, and this can be stale).
 * Its only job is letting the Data agent pick the right connection out of
 * several via db_list_connections' own output, with zero extra tool calls,
 * instead of introspecting every configured connection just to find out
 * which one has the relevant tables. Populated once when the connection is
 * added/edited, refreshed opportunistically whenever db_introspect_schema
 * is actually called against it later — see tools/db/schema-summary.ts.
 */
export interface DataConnectionSchemaSummary {
  tables: string[]
  /** True if `tables` was capped — the connection has more tables than are listed. */
  truncated: boolean
  updatedAt: number
}

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
  savedQueries: SavedQueryDto[]
  schemaSummary?: DataConnectionSchemaSummary
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

/** `id` omitted creates a new saved query. */
export interface SaveSavedQueryInput {
  id?: string
  connectionId: string
  name: string
  description: string
  sql: string
  params: SavedQueryParam[]
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

/**
 * A registered tool's public shape, for the Settings auto-approve rules
 * list. Tools whose `mutates` is statically `false` (never ask for
 * confirmation at all) are filtered out server-side — there'd be nothing
 * for an auto-approve toggle to do.
 */
export interface ToolDescriptor {
  name: string
  description: string
  mutates: 'always' | 'sometimes'
}
