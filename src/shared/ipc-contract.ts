import type { ContentBlock, StreamEvent } from './protocol'
import type { ContextWindowInfo } from './model-metadata'
import type { AgentRole } from './agents'

export type { ContextWindowInfo }

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
  /** TASKS.md #161 — separate from ProvidersList (chat/embedding providers); reuses the same generic ProvidersSetApiKey/ProvidersHasApiKey (keychain) channels below, keyed by the web-search provider's own id, same as the existing Tavily key already was. */
  WebSearchProvidersList: 'web-search-providers:list',
  ProvidersSetApiKey: 'providers:set-api-key',
  ProvidersHasApiKey: 'providers:has-api-key',
  /** Masked first-10/last-5 preview of a configured key, or null if none — lets Settings show every provider's status without ever sending a full key to the renderer. */
  ProvidersGetApiKeyPreview: 'providers:get-api-key-preview',
  ProvidersListModels: 'providers:list-models',

  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  /** TASKS.md #150 — admin-to-user settings provisioning, curated subset only (providers, MCP servers, DB connections). Never carries a live secret. */
  SettingsExport: 'settings:export',
  SettingsImportPreview: 'settings:import-preview',
  SettingsImportApply: 'settings:import-apply',

  DataConnectionsList: 'data-connections:list',
  DataConnectionsSave: 'data-connections:save',
  DataConnectionsDelete: 'data-connections:delete',

  ApiConnectionsList: 'api-connections:list',
  ApiConnectionsSave: 'api-connections:save',
  ApiConnectionsDelete: 'api-connections:delete',

  McpServersList: 'mcp-servers:list',
  McpServersSave: 'mcp-servers:save',
  McpServersDelete: 'mcp-servers:delete',

  EmailConnectionsList: 'email-connections:list',
  EmailConnectionsSave: 'email-connections:save',
  EmailConnectionsDelete: 'email-connections:delete',
  EmailConnectionsValidate: 'email-connections:validate',
  EmailConnectionsSetDefault: 'email-connections:set-default',
  McpServersReconnect: 'mcp-servers:reconnect',

  WorkspaceGetRoot: 'workspace:get-root',
  WorkspaceSetRoot: 'workspace:set-root',

  RolesGet: 'roles:get',
  RolesSetEnabled: 'roles:set-enabled',
  RolesOpenFolder: 'roles:open-folder',
  RolesCreateExample: 'roles:create-example',

  RuntimeGetState: 'runtime:get-state',
  /** Re-run `ensureWorkspace` (the "Retry" button): finishes a failed package install, or re-detects Python. */
  RuntimeEnsure: 'runtime:ensure',
  /** Delete and rebuild `<workspace>/venv` — explicit user action only. */
  RuntimeRepair: 'runtime:repair',
  /** Turn the Python runtime on/off ("continue without Python"). */
  RuntimeSetEnabled: 'runtime:set-enabled',
  /** Pushed from main whenever the runtime state changes. */
  RuntimeStateChanged: 'runtime:state-changed',

  SecretStorageGetInfo: 'secret-storage:get-info',
  SecretStorageSwitchToFile: 'secret-storage:switch-to-file',

  ToolsList: 'tools:list',
  ToolsListByRole: 'tools:list-by-role',

  ContextWindowGet: 'context-window:get',

  ChatSend: 'chat:send',
  ChatCancel: 'chat:cancel',
  /** TASKS.md #158: appends a mid-run steering comment for the given streamId — distinct from ChatSend, since it never starts a second run. */
  ChatSteer: 'chat:steer',
  ChatStreamEvent: 'chat:stream-event',

  ToolConfirmRequest: 'tools:confirm-request',
  ToolConfirmRespond: 'tools:confirm-respond',
  ToolValidateInput: 'tools:validate-input',

  /** Asked whenever a turn/delegate call's round or time budget runs out — lets the user grant more budget and keep going instead of the work being silently wrapped up. See orchestrator.ts's confirmContinue. */
  LimitReachedRequest: 'limit:reached-request',
  LimitReachedRespond: 'limit:reached-respond',

  SearchHistoryStatus: 'search-history:status',
  SearchHistoryRebuildIndex: 'search-history:rebuild-index',
  /** TASKS.md #162 — a real, small embed call against the given provider/model, returning the actual vector length rather than a guessed/hardcoded dimension. */
  EmbeddingProbeDimension: 'embedding:probe-dimension',

  SessionTitleUpdated: 'sessions:title-updated',

  /** One-way, renderer -> main: the hidden print window (see sessions/export.ts's PDF path) sends this once the transcript has actually finished rendering (DOM settled, fonts loaded) — the signal main waits on before calling printToPDF. */
  PrintReady: 'print:ready'
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

/** TASKS.md #161 — the web_search tool's own provider set, fetched via WebSearchProvidersList; a smaller shape than ProviderDescriptor since a web-search provider is just an id/displayName/requiresApiKey, no embeddings/model-list concept. */
export interface WebSearchProviderDescriptor {
  id: string
  displayName: string
  requiresApiKey: boolean
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
  state: 'empty' | 'ready' | 'needs-rebuild' | 'unavailable'
  indexed: number
  total: number
  /** Only set when `state` is 'unavailable' — the most recent embed attempt's error message. */
  reason?: string
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

/**
 * TASKS.md #150 — the curated, admin-provisionable subset of settings: chat
 * provider/model selection, MCP servers, database connections. Deliberately
 * excludes External API connections, email accounts, and every personal UI
 * preference (theme, `toolDetailsExpanded`, etc.) — the goal is org-level
 * connection provisioning, not overriding a user's own choices. **Never
 * carries a live secret** — no API key, no MCP bearer token, no DB
 * password — only connection *shape* (same "shape without the secret"
 * precedent #155's edit-by-id already established); an imported connection
 * needs its credentials filled in separately by whoever uses it.
 */
export interface SettingsExportPayload {
  formatVersion: 1
  exportedAt: string
  providers: {
    activeProviderId?: string
    /** providerId -> model, only for providers with a model actually selected locally. */
    models: Record<string, string>
  }
  mcpServers: Array<{
    name: string
    transport: McpTransport
    command?: string
    args?: string[]
    url?: string
    description?: string
  }>
  dataConnections: Array<{
    name: string
    engine: DbEngine
    filePath?: string
    host?: string
    port?: number
    database?: string
    username?: string
  }>
}

/** One entry in an import preview — `willImport: false` means a same-name/same-key entry already exists locally and this one will be skipped, not overwritten. */
export interface SettingsImportPreviewItem {
  category: 'provider' | 'mcpServer' | 'dataConnection'
  label: string
  willImport: boolean
}

export type SettingsExportResult = { cancelled: true } | { cancelled: false; path: string } | { error: string }

export type SettingsImportPreviewResult =
  | { cancelled: true }
  | { error: string }
  | { cancelled: false; payload: SettingsExportPayload; items: SettingsImportPreviewItem[] }

export interface SettingsImportApplyResult {
  imported: number
  skipped: number
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
  /** "<providerId>:<model>" that answered — assistant messages only, shown optionally (Settings > off by default). */
  model?: string
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
  /** Field names (e.g. "password") the confirmation dialog must render as real password inputs, kept out of the editable JSON textarea and never persisted into the tool_use content block — see #74's config-generator tools. */
  secretFields?: string[]
  /** True when the dialog should call ToolValidateInput before approving, so a bad connection is caught and can be corrected in the same dialog instead of round-tripping through a fresh tool call. */
  hasValidation?: boolean
}

/** A unique id for one limit-reached prompt — resolved once via LimitReachedRespond, never reused (a fresh one is generated each time the same turn hits a limit again after being granted more budget). */
export interface LimitReachedRequestPayload {
  streamId: string
  sessionId: string
  requestId: string
  reason: 'rounds' | 'time'
  roundsUsed: number
  maxRounds: number
  /** The specialist whose own delegate call hit the limit — undefined for the top-level turn itself. */
  agentRole?: AgentRole
}

export interface ToolValidateResult {
  ok: boolean
  error?: string
}

/** #75 — which backend provider keys/connection secrets are stored in, and where the file lives (shown as a read-only indicator in Settings once file mode is active). */
export interface SecretStorageInfo {
  mode: 'keychain' | 'file'
  envFilePath: string
}

export type DbEngine = 'sqlite' | 'postgres' | 'mssql' | 'mysql'

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

export type ApiAuthType = 'none' | 'apiKey' | 'bearer' | 'basic'

/**
 * A cheap, endpoint-count-only hint of what a connection's API exposes —
 * NOT a substitute for api_introspect (no parameters, and this can be
 * stale). Plays the same routing-hint role for api_list_connections that
 * DataConnectionSchemaSummary plays for db_list_connections. Populated only
 * when api_introspect actually runs against the connection — unlike a data
 * connection's schema summary, this is never warmed automatically on save,
 * since most APIs have no discoverable spec at all and probing every
 * connection on every save would mean real network latency/noise for the
 * common case of "no spec here."
 */
export interface ApiConnectionSpecSummary {
  endpointCount: number
  /** A handful of "METHOD /path" samples, capped — enough for api_list_connections to hint at what's available. */
  sample: string[]
  updatedAt: number
}

/** Connection metadata only — never carries the actual secret (API key / bearer token / basic password). */
export interface ApiConnectionDto {
  id: string
  name: string
  baseUrl: string
  authType: ApiAuthType
  /** apiKey auth only — the header name the key is sent in, e.g. "X-API-Key". */
  apiKeyHeader?: string
  /** basic auth only. */
  username?: string
  hasSecret: boolean
  /** Optional explicit OpenAPI/Swagger spec URL; when absent, api_introspect probes a handful of common well-known paths under baseUrl instead. */
  specUrl?: string
  specSummary?: ApiConnectionSpecSummary
}

/** `id` omitted creates a new connection; `secret` omitted on an edit leaves the stored one unchanged. */
export interface SaveApiConnectionInput {
  id?: string
  name: string
  baseUrl: string
  authType: ApiAuthType
  apiKeyHeader?: string
  username?: string
  secret?: string
  specUrl?: string
}

/**
 * App-password SMTP auth only — no OAuth2/Graph path (that's a separate,
 * not-yet-built flow for a real first-class Outlook/Microsoft 365 option;
 * see TASKS.md #79's already-documented Phase 2). A Microsoft-specific
 * app-password provider was tried here (2026-09-22) and reverted:
 * confirmed live (a real SMTP login attempt, not just docs) that Microsoft
 * has fully retired SMTP Basic Auth — app passwords included — for BOTH
 * Office 365/Microsoft 365 work accounts AND personal Outlook.com/Hotmail
 * accounts as of an April 2026 deadline that's already passed; there is no
 * per-account or admin toggle to bring it back. 'custom' covers any other
 * SMTP server (host/port/TLS given directly) — genuinely useful on its own
 * merits (Yahoo, iCloud, a company's own mail server, Zoho, ...), not a
 * Microsoft workaround.
 */
export type EmailProvider = 'gmail' | 'custom'

export interface EmailConnectionDto {
  id: string
  name: string
  emailAddress: string
  provider: EmailProvider
  /** `custom` only — nodemailer's own {host, port, secure} shape. */
  host?: string
  port?: number
  secure?: boolean
  hasSecret: boolean
  /** Computed, not stored per-connection (see data/email-connections.ts's resolveDefaultId) — what send_email uses when the caller doesn't name a connection. */
  isDefault: boolean
}

/** `id` omitted creates a new connection; `appPassword` omitted on an edit leaves the stored one unchanged. */
export interface SaveEmailConnectionInput {
  id?: string
  name: string
  emailAddress: string
  provider: EmailProvider
  host?: string
  port?: number
  secure?: boolean
  appPassword?: string
}

/** What the Settings "add account" form validates before ever saving — a real SMTP login attempt, no message sent. Unlike SaveEmailConnectionInput, appPassword is required here: the form only ever validates a freshly-typed password, never an edit that's keeping the old one. */
export interface ValidateEmailConnectionInput {
  provider: EmailProvider
  emailAddress: string
  appPassword: string
  host?: string
  port?: number
  secure?: boolean
}

export type McpTransport = 'stdio' | 'http'
export type McpServerStatus = 'connecting' | 'connected' | 'error'

/** Max characters of the user-written MCP server description (Settings, and pre-filled by the Configurator). */
export const MCP_SERVER_DESCRIPTION_MAX = 200

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
  /** User-written, length-capped one-liner: what this server is for. The only text about a server the assistant is shown that the user authored. */
  description?: string
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
  description?: string
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

/**
 * TASKS.md #164 — the full, unfiltered set of tools each role actually has,
 * grouped by role, as a reference for a user defining a new custom role
 * ("what can an existing role do that my new role might also need"). Unlike
 * `ToolDescriptor` above (built for the auto-approve list, which has nothing
 * useful to do with a tool that never mutates), `mutates` here includes
 * `'never'` so a read-only tool like `web_search` still shows up.
 */
export interface RoleToolsDto {
  role: string
  roleLabel: string
  summary: string
  tools: Array<{ name: string; description: string; mutates: 'always' | 'sometimes' | 'never' }>
}

/** A problem found while loading a role file (file-level errors, and quality warnings for a role that did load). */
export interface RoleProblemDto {
  /** File name within the roles folder. */
  file: string
  level: 'error' | 'warning'
  message: string
}

/** One role as the renderer sees it — built-in or user-defined. */
export interface RoleRosterEntryDto {
  id: string
  label: string
  summary: string
  description: string
  builtin: boolean
  pickable: boolean
  plannable: boolean
  /** User roles only: switched off in Settings. Built-ins are always enabled. */
  enabled: boolean
  /** Rough tokens this role adds to EVERY request (its delegate tool, plus its line in the planner's role list when plannable). */
  tokenCost: number
  /** Quality warnings for a user role that loaded. */
  warnings: string[]
  /** User roles: file name within the roles folder. */
  file?: string
  /** True when the file's latest edit has errors and the previous working version is in use. */
  stale?: boolean
}

/** Everything the renderer needs about roles, in one call: the picker, the labels, and the Settings > Roles list. */
export interface RoleRosterDto {
  roles: RoleRosterEntryDto[]
  problems: RoleProblemDto[]
  /** Absolute path of the user roles folder. */
  folder: string
  /** Tokens the ENABLED user roles add to every request, together. */
  userTokenCost: number
  /** Set when the enabled user roles together are heavy enough to be worth a warning. */
  budgetWarning?: string
}
