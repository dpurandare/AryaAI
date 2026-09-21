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
  type SaveApiConnectionInput,
  type SaveEmailConnectionInput,
  type SaveDataConnectionInput,
  type SaveMcpServerInput,
  type ChatStreamEventPayload,
  type SessionExportResult,
  type ToolConfirmRequestPayload,
  type ToolDescriptor,
  type ToolValidateResult,
  type SecretStorageInfo,
  type SearchHistoryStatusDto,
  type SessionTitleUpdatedPayload
} from '@shared/ipc-contract'
import type { AgentRole } from '@shared/agents'
import { createSession, listSessions, deleteSession, getSession, updateSessionTitle, titleFromMessage } from '../db/sessions'
import { insertMessage, listMessages } from '../db/messages'
import { enqueueMessage, getEmbeddingConfig, getIndexState, rebuildIndex, runBackfill } from '../search-history/indexer'
import { getSetting, setSetting } from '../db/settings'
import { addUsage, getUsage } from '../db/usage'
import { setApiKey, getApiKey, envFilePath, getSecretStorageMode, switchToFileStorage } from '../security/keychain'
import { WorkspaceGuard } from '../security/workspace-guard'
import {
  deleteConnection,
  getConnection,
  listConnections,
  listSavedQueries,
  saveConnection,
  updateConnectionSchemaSummary
} from '../data/connections'
import { deleteApiConnection, listApiConnections, saveApiConnection } from '../data/api-connections'
import { deleteEmailConnection, listEmailConnections, saveEmailConnection } from '../data/email-connections'
import { verifyGmailConnection } from '../tools/email/transport'
import { prepareConversation, resolveContextWindow } from '../context/prepare-context'
import { deleteServerConfig, listServerConfigs, saveServerConfig } from '../mcp/config'
import { McpManager } from '../mcp/manager'
import { openDriver } from '../tools/db/driver-factory'
import { buildSchemaSummary } from '../tools/db/schema-summary'
import { SavedQueryToolManager } from '../tools/db/saved-query-manager'
import { createDefaultProviderRegistry } from '../providers/setup'
import type { Message, ModelProvider } from '../providers/types'
import { exportSession } from '../sessions/export'
import {
  createDefaultRegistry,
  createToolContext,
  defaultWorkspaceRoot,
  PLANNING_ENABLED_SETTING_KEY,
  WORKSPACE_ROOT_SETTING_KEY
} from '../tools/setup'
import type { ToolContext } from '../tools/types'
import { Orchestrator, type ConfirmDecision, type ToolConfirmRequest } from '../agents/orchestrator'
import { createAgents } from '../agents/roles'

// search_history is registered in the default tool registry (tools/setup.ts),
// which makes it directly callable at the top level, not just via a
// delegated Research round — but until this line existed, only Research's
// own systemPrompt (roles.ts) ever told a model when to reach for it. A
// top-level "Auto" conversation had the tool available with no prompted
// reason to use it, so a "do you remember..." question got answered from
// the model's own (nonexistent) memory instead of an actual search —
// confirmed live: searchIndex() itself correctly found the right past
// session when queried directly, so this was a missing-instruction gap,
// not a broken search.
const SYSTEM_PROMPT =
  "You are Sachivji, a helpful AI assistant running locally on the user's machine. When asked to " +
  'recall something from an earlier conversation, or to compare how a detail changed over time, use ' +
  "the search_history tool (it searches the user's own past sessions, including this one — useful " +
  'if this conversation has grown long enough that something earlier may no longer be visible to ' +
  "you) rather than guessing or claiming you have no memory of past conversations. If it reports no results or " +
  "that it's unavailable, say so plainly instead of working around it. A request can need more than " +
  'just retrieving that past context — e.g. "search for the analysis we did for X, and show a ' +
  'comparison for Y" means finding X via search_history AND THEN actually redoing the analysis for Y ' +
  "using the same method, presented as a comparison — not just relaying the retrieved excerpt as the " +
  'whole answer. To set up a new Database, External API, or MCP server connection from details the user ' +
  'gives you in chat, use db_create_connection/api_create_connection/mcp_create_connection instead of ' +
  'telling the user to fill out the corresponding Settings form by hand — gather the non-secret details ' +
  "yourself, but never ask the user to type a password/API key/token/bearer token into chat: the " +
  "confirmation dialog that appears has its own real password field for that, which never reaches you. " +
  'Each of these tools tests the connection for real before saving it, so a bad host/credential fails ' +
  'clearly right away. To build a PowerPoint presentation: call pptx_start_deck once, then for each ' +
  'planned slide call pptx_add_slide and delegate_to_page-creator with a brief for that slide (heading, ' +
  'key content/data points, tone/style notes) — page-creator decides the actual visual design and calls ' +
  "pptx_compose_slide itself; you decide the deck's overall structure/flow/slide order, not what a slide " +
  'looks like. pptx_add_slide/pptx_compose_slide/pptx_save_deck only need an explicit deckId if you are ' +
  'building more than one deck in the same turn — omit it otherwise, since it is a short opaque id that ' +
  'is easy to mistype or invent by accident when passed through a task description; only mention it in ' +
  "a page-creator brief if you're certain of the exact value. If a slide's result looks thin, wrong, or " +
  'incomplete, first retry that one delegate_to_page-creator call yourself with a more specific/' +
  "corrective brief (e.g. \"simplify, fewer elements\"); if it still isn't right after that, stop and " +
  'ask the user for their own direction on that slide rather than retrying indefinitely. Call ' +
  'pptx_save_deck exactly once, after every planned slide has been composed. To send an email, use ' +
  'delegate_to_email with the recipients and roughly what it should say — it drafts the actual subject/ ' +
  'body itself and sends it directly (with its own confirmation dialog), so you do not need to draft the ' +
  'message yourself first.'

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
  ipcMain.handle(IpcChannel.DataConnectionsSave, async (_event, input: SaveDataConnectionInput) => {
    const saved = saveConnection(input)
    // Warm the schema-summary cache right away (db_list_connections then
    // has something real to show immediately) instead of waiting for the
    // Data agent to stumble into it — best-effort: a bad path/host at add
    // time just leaves no cached summary yet, surfaced as a real,
    // immediate error the first time the connection is actually queried,
    // same as it always has been. Never blocks/fails the save itself.
    try {
      const driver = openDriver(saved.id)
      try {
        updateConnectionSchemaSummary(saved.id, buildSchemaSummary(await driver.introspectSchema()))
      } finally {
        await driver.close()
      }
    } catch {
      // Left uncached — see comment above.
    }
    return getConnection(saved.id) ?? saved
  })
  ipcMain.handle(IpcChannel.DataConnectionsDelete, (_event, id: string) => {
    // Saved queries live nested inside the connection (data/connections.ts)
    // and are removed automatically with it — but their *tools* are a
    // separate live registration this app owns, so those still need an
    // explicit unregister or they'd keep appearing to work right up until
    // the next call fails ("connection no longer exists") instead of just
    // not existing.
    for (const query of listSavedQueries(id)) {
      savedQueryManager.unregister(query.id, toolRegistry)
    }
    deleteConnection(id)
  })

  ipcMain.handle(IpcChannel.ApiConnectionsList, () => listApiConnections())
  ipcMain.handle(IpcChannel.ApiConnectionsSave, (_event, input: SaveApiConnectionInput) => saveApiConnection(input))
  ipcMain.handle(IpcChannel.ApiConnectionsDelete, (_event, id: string) => deleteApiConnection(id))

  ipcMain.handle(IpcChannel.EmailConnectionsList, () => listEmailConnections())
  ipcMain.handle(IpcChannel.EmailConnectionsSave, (_event, input: SaveEmailConnectionInput) => saveEmailConnection(input))
  ipcMain.handle(IpcChannel.EmailConnectionsDelete, (_event, id: string) => deleteEmailConnection(id))
  // A real login handshake before saving, same "successful probe is the
  // validation" principle as #74's config-generator tools — this is a
  // plain Settings form (no agent tool call involved), so it's just a
  // direct pre-save check the renderer calls itself, not the
  // ToolValidateInput/confirmation-dialog machinery that's specific to
  // agent-created connections.
  ipcMain.handle(
    IpcChannel.EmailConnectionsValidate,
    async (_event, emailAddress: string, appPassword: string): Promise<ToolValidateResult> => {
      try {
        await verifyGmailConnection(emailAddress, appPassword)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

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

  ipcMain.handle(
    IpcChannel.SecretStorageGetInfo,
    (): SecretStorageInfo => ({ mode: getSecretStorageMode(), envFilePath: envFilePath() })
  )
  ipcMain.handle(IpcChannel.SecretStorageSwitchToFile, (): SecretStorageInfo => {
    switchToFileStorage()
    return { mode: getSecretStorageMode(), envFilePath: envFilePath() }
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

  // Pull-based counterpart to the context_window *stream* event runChat
  // emits mid-turn — that one only refreshes once a message is actually
  // sent in a session; the context window depends on the current
  // provider/model choice, not the session, so the renderer also calls
  // this proactively (app startup, provider/model change) to avoid ever
  // showing a stale/static guess for a session nobody has messaged in yet
  // during this process's lifetime. Returns null rather than throwing when
  // nothing is configured (a fresh install, no key set) — this is a
  // background query, not a chat send the user is blocked on.
  ipcMain.handle(IpcChannel.ContextWindowGet, async () => {
    const resolved = tryResolveActiveProvider()
    if (!resolved) return null
    return resolveContextWindow(resolved.model, resolved.provider)
  })

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

  // Called by ToolConfirmDialog before approving a tool that declares
  // `validate` (see Tool's own doc comment) — a pure probe, no persistence,
  // callable repeatedly with corrected input so a bad connection can be
  // fixed in the same dialog instead of round-tripping through a fresh
  // model tool call.
  ipcMain.handle(
    IpcChannel.ToolValidateInput,
    async (_event, name: string, input: Record<string, unknown>): Promise<ToolValidateResult> => {
      const tool = toolRegistry.get(name)
      if (!tool?.validate) return { ok: true }
      if (!toolContext) return { ok: false, error: 'Tool context not initialized.' }
      try {
        await tool.validate(input, { ...toolContext, currentSessionId: 'validate' })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
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

/**
 * A tolerant mirror of runChat's own provider/model lookup below — returns
 * undefined instead of throwing when nothing is configured yet (fresh
 * install, no key set, no model chosen), since the only caller
 * (ContextWindowGet) is a background query the renderer polls
 * proactively, not a chat send the user is waiting on and would need a
 * real error surfaced for. Deliberately kept separate from runChat's own
 * checks rather than factored to share one implementation — runChat's
 * error messages are user-facing and specific ("No API key configured for
 * X. Add one in Settings."); collapsing both call sites onto one shared
 * helper would mean either this one starts throwing (wrong for a
 * best-effort background query) or runChat loses its specific messages.
 */
function tryResolveActiveProvider(): { provider: ModelProvider; model: string } | undefined {
  const providerId = getSetting(ACTIVE_PROVIDER_KEY) ?? DEFAULT_PROVIDER_ID
  const model = getSetting(modelSettingKey(providerId))
  const descriptor = providerRegistry.get(providerId)
  if (!descriptor || !model) return undefined
  const apiKey = getApiKey(providerId)
  if (descriptor.requiresApiKey && !apiKey) return undefined
  return { provider: descriptor.create(apiKey), model }
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
  const { messages: conversation, droppedTurns, contextWindow } = await prepareConversation(priorTurns, model, provider, {
    system: SYSTEM_PROMPT,
    // The top-level round's real tool list — matches what's actually about
    // to be sent alongside this conversation (built just below via the
    // same toolRegistry.list()). Doesn't include the delegate_to_<role>
    // synthetic tools the Orchestrator adds internally per specialist —
    // those are few and small next to the full registry, and not known
    // until the Orchestrator itself is constructed a few lines down.
    tools: toolRegistry.list()
  })
  // Once per turn, not per round — tells the renderer's context meter the
  // real window this turn was budgeted against (a live Ollama reading when
  // available) instead of it falling back to its own static guess, which
  // for a local model can be badly wrong in either direction. See
  // shared/protocol.ts's context_window doc comment.
  emit(sender, {
    streamId,
    sessionId,
    event: { type: 'context_window', tokens: contextWindow.tokens, isEstimate: contextWindow.isEstimate }
  })
  // Found live: dropping old turns from context was completely silent —
  // indistinguishable, from the user's side, from the model simply having
  // a worse memory. The turns are still safe (SQLite + the UI transcript
  // are untouched by trimming), but the *model* genuinely loses access to
  // them for the rest of this conversation, so say so — and since
  // search_history no longer excludes the current session (see
  // search-history/tool.ts), this is now also genuinely actionable, not
  // just an FYI.
  if (droppedTurns.length > 0) {
    const message =
      `This conversation has grown long enough that ${droppedTurns.length} earlier turn` +
      `${droppedTurns.length === 1 ? '' : 's'} were dropped from what I can see, to fit the ` +
      "model's context window. They're still saved and visible above — ask me to search this " +
      "conversation's own history if you need something from them."
    emit(sender, { streamId, sessionId, event: { type: 'warning', message } })
    const warningRecord = insertMessage(sessionId, 'assistant', [{ type: 'warning', message }])
    enqueueMessage(warningRecord.id, sessionId, warningRecord.content)
  }
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
    {
      ...toolContext,
      currentSessionId: sessionId,
      registerSavedQuery: (query) => savedQueryManager.register(query, toolRegistry),
      connectMcpServer: (id) => mcpManager.reconnect(id, toolRegistry),
      activeDecks: new Map()
    },
    signal,
    // Missing/unset reads as enabled — default on (see PLANNING_ENABLED_SETTING_KEY's own doc comment).
    { planningEnabled: getSetting(PLANNING_ENABLED_SETTING_KEY) !== 'false' }
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
