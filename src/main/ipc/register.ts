import { app, BrowserWindow, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { userInfo } from 'node:os'
import {
  IpcChannel,
  DEFAULT_SESSION_TITLE,
  type AppInfo,
  type SaveDataConnectionInput,
  type SaveMcpServerInput,
  type ChatStreamEventPayload,
  type SessionExportResult,
  type ToolConfirmRequestPayload,
  type ToolDescriptor,
  type SearchHistoryStatusDto,
  type SessionTitleUpdatedPayload,
  type SaveSavedQueryInput
} from '@shared/ipc-contract'
import type { AgentRole } from '@shared/agents'
import { createSession, listSessions, deleteSession, getSession, updateSessionTitle, titleFromMessage } from '../db/sessions'
import { insertMessage, listMessages } from '../db/messages'
import { enqueueMessage, getEmbeddingConfig, getIndexState, rebuildIndex, runBackfill } from '../search-history/indexer'
import { getSetting, setSetting } from '../db/settings'
import { addUsage, getUsage } from '../db/usage'
import { setApiKey, getApiKey } from '../security/keychain'
import { WorkspaceGuard } from '../security/workspace-guard'
import { deleteConnection, listConnections, saveConnection } from '../data/connections'
import { deleteSavedQuery, listSavedQueries, saveSavedQuery } from '../data/saved-queries'
import { prepareConversation } from '../context/prepare-context'
import { deleteServerConfig, listServerConfigs, saveServerConfig } from '../mcp/config'
import { McpManager } from '../mcp/manager'
import { SavedQueryToolManager } from '../tools/db/saved-query-manager'
import { createDefaultProviderRegistry } from '../providers/setup'
import type { Message } from '../providers/types'
import { exportSession } from '../sessions/export'
import { createDefaultRegistry, createToolContext, defaultWorkspaceRoot, WORKSPACE_ROOT_SETTING_KEY } from '../tools/setup'
import type { ToolContext } from '../tools/types'
import { Orchestrator, type ConfirmDecision, type ToolConfirmRequest } from '../agents/orchestrator'
import { createAgents } from '../agents/roles'

const SYSTEM_PROMPT = "You are Sachivji, a helpful AI assistant running locally on the user's machine."

const providerRegistry = createDefaultProviderRegistry()

const ACTIVE_PROVIDER_KEY = 'activeProviderId'
const DEFAULT_PROVIDER_ID = 'openai'

function modelSettingKey(providerId: string): string {
  return `model:${providerId}`
}

const toolRegistry = createDefaultRegistry()
const agents = createAgents(toolRegistry)
const mcpManager = new McpManager()
const savedQueryManager = new SavedQueryToolManager()
let toolContext: ToolContext | undefined

const pendingConfirmations = new Map<string, (decision: ConfirmDecision) => void>()
const activeStreams = new Map<string, AbortController>()

/**
 * Central place where every ipcMain.handle/on channel is registered.
 * As agents/providers/tools land, each module registers its own channels
 * here rather than main/index.ts growing a pile of handlers.
 */
export function registerIpcHandlers(): void {
  toolContext = createToolContext()

  // Fire-and-forget: connecting can involve spawning a process or a network
  // round trip, and shouldn't block app startup. toolRegistry.list() is
  // re-read fresh on every chat send, so tools just appear once ready.
  mcpManager.connectAll(toolRegistry).catch((err: unknown) => {
    console.error('Failed to connect configured MCP servers:', err)
  })

  // Synchronous, unlike MCP connect above — no network/process involved,
  // saved queries are just settings data, so there's nothing to await.
  savedQueryManager.syncAll(toolRegistry)

  // Fire-and-forget, same reasoning as MCP connect above — catches up any
  // messages missing from the search_history index without blocking startup.
  runBackfill().catch((err: unknown) => {
    console.error('search_history: backfill failed:', err)
  })

  ipcMain.handle(
    IpcChannel.AppGetInfo,
    (): AppInfo => ({
      name: 'Sachivji',
      version: app.getVersion(),
      platform: process.platform,
      userName: userInfo().username
    })
  )

  ipcMain.handle(IpcChannel.SessionsList, () => listSessions())
  ipcMain.handle(IpcChannel.SessionsCreate, (_event, title: string) => createSession(title))
  ipcMain.handle(IpcChannel.SessionsDelete, (_event, id: string) => deleteSession(id))
  ipcMain.handle(IpcChannel.SessionsExport, (event, sessionId: string): Promise<SessionExportResult> =>
    exportSession(sessionId, BrowserWindow.fromWebContents(event.sender))
  )

  ipcMain.handle(IpcChannel.MessagesList, (_event, sessionId: string) => listMessages(sessionId))
  ipcMain.handle(IpcChannel.SessionsGetUsage, (_event, sessionId: string) => getUsage(sessionId))

  ipcMain.handle(IpcChannel.ProvidersList, () =>
    providerRegistry
      .list()
      .map(({ id, displayName, requiresApiKey, supportsEmbeddings }) => ({
        id,
        displayName,
        requiresApiKey,
        supportsEmbeddings
      }))
  )
  ipcMain.handle(IpcChannel.ProvidersSetApiKey, (_event, providerId: string, apiKey: string) => {
    setApiKey(providerId, apiKey)
  })
  ipcMain.handle(IpcChannel.ProvidersHasApiKey, (_event, providerId: string) =>
    Boolean(getApiKey(providerId))
  )
  ipcMain.handle(IpcChannel.ProvidersListModels, async (_event, providerId: string) => {
    const descriptor = providerRegistry.get(providerId)
    if (!descriptor) {
      throw new Error(`Unknown provider "${providerId}".`)
    }
    const apiKey = getApiKey(providerId)
    if (descriptor.requiresApiKey && !apiKey) {
      throw new Error(`No API key configured for ${providerId}.`)
    }
    return descriptor.create(apiKey).listModels()
  })

  ipcMain.handle(IpcChannel.SettingsGet, (_event, key: string) => getSetting(key) ?? null)
  ipcMain.handle(IpcChannel.SettingsSet, (_event, key: string, value: string) =>
    setSetting(key, value)
  )

  ipcMain.handle(IpcChannel.DataConnectionsList, () => listConnections())
  ipcMain.handle(IpcChannel.DataConnectionsSave, (_event, input: SaveDataConnectionInput) =>
    saveConnection(input)
  )
  ipcMain.handle(IpcChannel.DataConnectionsDelete, (_event, id: string) => {
    // Saved queries reference a connection by id (data/saved-queries.ts) —
    // deleting the connection out from under them would leave their tools
    // registered but permanently failing at execute() time ("connection no
    // longer exists"), instead of just not existing. Delete them first.
    for (const query of listSavedQueries(id)) {
      deleteSavedQuery(query.id)
      savedQueryManager.unregister(query.id, toolRegistry)
    }
    deleteConnection(id)
  })

  ipcMain.handle(IpcChannel.SavedQueriesList, (_event, connectionId?: string) => listSavedQueries(connectionId))
  ipcMain.handle(IpcChannel.SavedQueriesSave, (_event, input: SaveSavedQueryInput) => {
    const saved = saveSavedQuery(input)
    savedQueryManager.register(saved, toolRegistry)
    return saved
  })
  ipcMain.handle(IpcChannel.SavedQueriesDelete, (_event, id: string) => {
    deleteSavedQuery(id)
    savedQueryManager.unregister(id, toolRegistry)
  })

  ipcMain.handle(IpcChannel.McpServersList, () =>
    listServerConfigs().map((config) => {
      const status = mcpManager.getStatus(config.id)
      return {
        ...config,
        status: status?.status ?? 'connecting',
        error: status?.error,
        toolCount: status?.toolCount ?? 0
      }
    })
  )
  ipcMain.handle(IpcChannel.McpServersSave, async (_event, input: SaveMcpServerInput) => {
    const config = saveServerConfig(input)
    await mcpManager.reconnect(config.id, toolRegistry)
    return config
  })
  ipcMain.handle(IpcChannel.McpServersDelete, (_event, id: string) => {
    mcpManager.disconnect(id, toolRegistry)
    deleteServerConfig(id)
  })
  ipcMain.handle(IpcChannel.McpServersReconnect, (_event, id: string) => mcpManager.reconnect(id, toolRegistry))

  ipcMain.handle(IpcChannel.WorkspaceGetRoot, () => toolContext?.workspaceGuard.root ?? defaultWorkspaceRoot())
  ipcMain.handle(IpcChannel.WorkspaceSetRoot, (_event, path: string) => {
    if (!path || !isAbsolute(path)) {
      throw new Error('Workspace root must be a non-empty absolute path.')
    }
    mkdirSync(path, { recursive: true })
    setSetting(WORKSPACE_ROOT_SETTING_KEY, path)
    if (toolContext) {
      // Mutated in place, not reassigned — `toolContext` is the same object
      // reference `runChat` reads fresh on every call, so this takes effect
      // on the very next message with no app restart.
      toolContext.workspaceGuard = new WorkspaceGuard(path)
    }
  })

  ipcMain.handle(IpcChannel.ToolsList, (): ToolDescriptor[] =>
    toolRegistry
      .list()
      .filter((tool) => typeof tool.mutates === 'function' || tool.mutates === true)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        mutates: typeof tool.mutates === 'function' ? 'sometimes' : 'always'
      }))
  )

  ipcMain.handle(IpcChannel.SearchHistoryStatus, (): SearchHistoryStatusDto => {
    const config = getEmbeddingConfig()
    const state = getIndexState()
    return {
      providerId: config.providerId,
      model: config.model,
      state: state.kind,
      indexed: state.kind === 'ready' ? state.indexed : 0,
      total: state.kind === 'ready' ? state.total : 0
    }
  })
  ipcMain.handle(IpcChannel.SearchHistoryRebuildIndex, () => rebuildIndex())

  ipcMain.handle(
    IpcChannel.ChatSend,
    (event, sessionId: string, text: string, forcedRole: AgentRole | null) => {
      const streamId = randomUUID()
      const sender = event.sender
      // Created and registered synchronously, before returning streamId to
      // the renderer, so a ChatCancel that arrives immediately after can
      // never race ahead of this being in the map.
      const controller = new AbortController()
      activeStreams.set(streamId, controller)
      runChat(sessionId, text, streamId, sender, forcedRole, controller.signal)
        .catch((err: unknown) => {
          emit(sender, {
            streamId,
            sessionId,
            event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
          })
        })
        .finally(() => activeStreams.delete(streamId))
      return { streamId }
    }
  )

  ipcMain.handle(IpcChannel.ChatCancel, (_event, streamId: string) => {
    // A no-op if the stream already finished — same defensive shape as
    // ToolConfirmRespond's "no matching pending entry" handling below.
    activeStreams.get(streamId)?.abort()
  })

  ipcMain.handle(
    IpcChannel.ToolConfirmRespond,
    (_event, toolUseId: string, approved: boolean, input?: Record<string, unknown>) => {
      const resolve = pendingConfirmations.get(toolUseId)
      if (!resolve) return
      pendingConfirmations.delete(toolUseId)
      resolve({ approved, input })
    }
  )
}

function emit(sender: WebContents, payload: ChatStreamEventPayload): void {
  sender.send(IpcChannel.ChatStreamEvent, payload)
}

/** Builds the confirmation callback the Orchestrator uses for every mutating tool call, at any nesting level. */
function makeConfirmTool(
  sender: WebContents,
  streamId: string,
  sessionId: string
): (request: ToolConfirmRequest) => Promise<ConfirmDecision> {
  return (request) =>
    new Promise((resolve) => {
      pendingConfirmations.set(request.toolUseId, resolve)
      const payload: ToolConfirmRequestPayload = { streamId, sessionId, ...request }
      sender.send(IpcChannel.ToolConfirmRequest, payload)
    })
}

async function runChat(
  sessionId: string,
  text: string,
  streamId: string,
  sender: WebContents,
  forcedRole: AgentRole | null,
  signal: AbortSignal
): Promise<void> {
  const providerId = getSetting(ACTIVE_PROVIDER_KEY) ?? DEFAULT_PROVIDER_ID
  const model = getSetting(modelSettingKey(providerId))
  const apiKey = getApiKey(providerId)
  const descriptor = providerRegistry.get(providerId)

  if (!descriptor) {
    throw new Error(`Unknown provider "${providerId}".`)
  }
  if (descriptor.requiresApiKey && !apiKey) {
    throw new Error(`No API key configured for ${providerId}. Add one in Settings.`)
  }
  if (!model) {
    throw new Error(`No model configured for ${providerId}. Set one in Settings.`)
  }
  if (!toolContext) {
    throw new Error('Tool context not initialized.')
  }

  const provider = descriptor.create(apiKey)

  // Read once, up front, and acted on only after the turn actually
  // completes (below) — checking the session's *current title*, not a
  // message count, so a first attempt that errors out mid-turn (thrown
  // before reaching the rename) still leaves the next successful attempt
  // able to auto-title, rather than a message-count check silently
  // consuming the "first turn" opportunity on a failed one.
  const sessionBeforeTurn = getSession(sessionId)

  const history = listMessages(sessionId)
  const priorTurns: Message[] = history.map((m) => ({ role: m.role, content: m.content }))
  // Trims oversized tool results and drops the oldest turns once the loaded
  // history is getting close to the model's context window — operates only
  // on what's about to be sent, never on what's persisted/displayed.
  const conversation = await prepareConversation(priorTurns, model, provider)
  conversation.push({ role: 'user', content: [{ type: 'text', text }] })
  const userMessage = insertMessage(sessionId, 'user', [{ type: 'text', text }])
  enqueueMessage(userMessage.id, sessionId, userMessage.content)

  const orchestrator = new Orchestrator(
    provider,
    model,
    agents,
    SYSTEM_PROMPT,
    toolRegistry.list(),
    makeConfirmTool(sender, streamId, sessionId),
    { ...toolContext, currentSessionId: sessionId },
    signal
  )

  for await (const orchestratorEvent of orchestrator.run(conversation, forcedRole)) {
    if (orchestratorEvent.kind === 'stream') {
      emit(sender, { streamId, sessionId, event: orchestratorEvent.event })
      if (orchestratorEvent.event.type === 'usage') {
        addUsage(sessionId, orchestratorEvent.event.inputTokens, orchestratorEvent.event.outputTokens)
      }
    } else {
      const record = insertMessage(sessionId, orchestratorEvent.role, orchestratorEvent.content)
      enqueueMessage(record.id, sessionId, record.content)
    }
  }

  // "Asked and answered" — only once, only from a session's actual first
  // exchange (the title guard above), and only once the turn has genuinely
  // finished (success or a clean abort both reach here; a thrown error does
  // not, leaving the opportunity open for the next attempt).
  if (sessionBeforeTurn?.title === DEFAULT_SESSION_TITLE) {
    const title = titleFromMessage(text)
    updateSessionTitle(sessionId, title)
    const payload: SessionTitleUpdatedPayload = { sessionId, title }
    sender.send(IpcChannel.SessionTitleUpdated, payload)
  }
}
