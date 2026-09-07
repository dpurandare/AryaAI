import { app, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  IpcChannel,
  type AppInfo,
  type ChatStreamEventPayload,
  type ToolConfirmRequestPayload
} from '@shared/ipc-contract'
import type { ContentBlock } from '@shared/protocol'
import { createSession, listSessions, deleteSession } from '../db/sessions'
import { insertMessage, listMessages } from '../db/messages'
import { getSetting, setSetting } from '../db/settings'
import { setApiKey, getApiKey } from '../security/keychain'
import { AnthropicProvider } from '../providers/anthropic'
import { OpenAIProvider } from '../providers/openai'
import type { Message, ModelProvider, StreamEvent } from '../providers/types'
import { createDefaultRegistry, createToolContext } from '../tools/setup'
import type { ToolContext } from '../tools/types'

const SYSTEM_PROMPT = "You are Sachiv, a helpful AI assistant running locally on the user's machine."

const PROVIDER_FACTORIES: Record<string, (apiKey: string) => ModelProvider> = {
  anthropic: (key) => new AnthropicProvider(key),
  openai: (key) => new OpenAIProvider(key)
}

const ACTIVE_PROVIDER_KEY = 'activeProviderId'
const DEFAULT_PROVIDER_ID = 'openai'
const MAX_TOOL_ROUNDS = 8

function modelSettingKey(providerId: string): string {
  return `model:${providerId}`
}

const toolRegistry = createDefaultRegistry()
let toolContext: ToolContext | undefined

interface ConfirmDecision {
  approved: boolean
  input?: Record<string, unknown>
}

const pendingConfirmations = new Map<string, (decision: ConfirmDecision) => void>()

/**
 * Central place where every ipcMain.handle/on channel is registered.
 * As agents/providers/tools land, each module registers its own channels
 * here rather than main/index.ts growing a pile of handlers.
 */
export function registerIpcHandlers(): void {
  toolContext = createToolContext()

  ipcMain.handle(
    IpcChannel.AppGetInfo,
    (): AppInfo => ({
      name: 'Sachiv',
      version: app.getVersion(),
      platform: process.platform
    })
  )

  ipcMain.handle(IpcChannel.SessionsList, () => listSessions())
  ipcMain.handle(IpcChannel.SessionsCreate, (_event, title: string) => createSession(title))
  ipcMain.handle(IpcChannel.SessionsDelete, (_event, id: string) => deleteSession(id))

  ipcMain.handle(IpcChannel.MessagesList, (_event, sessionId: string) => listMessages(sessionId))

  ipcMain.handle(IpcChannel.ProvidersSetApiKey, (_event, providerId: string, apiKey: string) => {
    setApiKey(providerId, apiKey)
  })
  ipcMain.handle(IpcChannel.ProvidersHasApiKey, (_event, providerId: string) =>
    Boolean(getApiKey(providerId))
  )
  ipcMain.handle(IpcChannel.ProvidersListModels, async (_event, providerId: string) => {
    const apiKey = getApiKey(providerId)
    const factory = PROVIDER_FACTORIES[providerId]
    if (!factory || !apiKey) {
      throw new Error(`No API key configured for ${providerId}.`)
    }
    return factory(apiKey).listModels()
  })

  ipcMain.handle(IpcChannel.SettingsGet, (_event, key: string) => getSetting(key) ?? null)
  ipcMain.handle(IpcChannel.SettingsSet, (_event, key: string, value: string) =>
    setSetting(key, value)
  )

  ipcMain.handle(IpcChannel.ChatSend, (event, sessionId: string, text: string) => {
    const streamId = randomUUID()
    const sender = event.sender
    runChat(sessionId, text, streamId, sender).catch((err: unknown) => {
      emit(sender, {
        streamId,
        sessionId,
        event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
      })
    })
    return { streamId }
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

/** Asks the renderer to approve a mutating tool call and waits for the reply. */
function requestToolConfirmation(
  sender: WebContents,
  payload: ToolConfirmRequestPayload
): Promise<ConfirmDecision> {
  return new Promise((resolve) => {
    pendingConfirmations.set(payload.toolUseId, resolve)
    sender.send(IpcChannel.ToolConfirmRequest, payload)
  })
}

interface AccumulatedToolCall {
  id: string
  name: string
  inputJson: string
}

async function runChat(
  sessionId: string,
  text: string,
  streamId: string,
  sender: WebContents
): Promise<void> {
  const providerId = getSetting(ACTIVE_PROVIDER_KEY) ?? DEFAULT_PROVIDER_ID
  const model = getSetting(modelSettingKey(providerId))
  const apiKey = getApiKey(providerId)
  const factory = PROVIDER_FACTORIES[providerId]

  if (!factory) {
    throw new Error(`Unknown provider "${providerId}".`)
  }
  if (!apiKey) {
    throw new Error(`No API key configured for ${providerId}. Add one in Settings.`)
  }
  if (!model) {
    throw new Error(`No model configured for ${providerId}. Set one in Settings.`)
  }
  if (!toolContext) {
    throw new Error('Tool context not initialized.')
  }

  const history = listMessages(sessionId)
  const conversation: Message[] = history.map((m) => ({ role: m.role, content: m.content }))
  conversation.push({ role: 'user', content: [{ type: 'text', text }] })
  insertMessage(sessionId, 'user', [{ type: 'text', text }])

  const provider = factory(apiKey)
  const toolDefinitions = toolRegistry.toDefinitions()

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistantText = ''
    const toolCalls: AccumulatedToolCall[] = []
    const toolCallsById = new Map<string, AccumulatedToolCall>()
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'

    for await (const event of provider.stream({
      model,
      system: SYSTEM_PROMPT,
      messages: conversation,
      maxTokens: 4096,
      tools: toolDefinitions.length ? toolDefinitions : undefined
    })) {
      if (event.type === 'text_delta') {
        assistantText += event.text
      } else if (event.type === 'tool_use_start') {
        const call: AccumulatedToolCall = { id: event.id, name: event.name, inputJson: '' }
        toolCalls.push(call)
        toolCallsById.set(event.id, call)
      } else if (event.type === 'tool_use_delta') {
        const call = toolCallsById.get(event.id)
        if (call) call.inputJson += event.partialInput
      } else if (event.type === 'message_stop') {
        stopReason = event.stopReason
      }
      emit(sender, { streamId, sessionId, event: event as StreamEvent })
    }

    const assistantBlocks: ContentBlock[] = []
    if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText })
    const inputByCallId = new Map<string, Record<string, unknown>>()
    for (const call of toolCalls) {
      let input: Record<string, unknown> = {}
      try {
        input = call.inputJson ? JSON.parse(call.inputJson) : {}
      } catch {
        // Malformed tool input is surfaced back to the model as an error result below.
      }
      inputByCallId.set(call.id, input)
      assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input })
    }
    if (assistantBlocks.length) insertMessage(sessionId, 'assistant', assistantBlocks)
    conversation.push({ role: 'assistant', content: assistantBlocks })

    if (stopReason !== 'tool_use' || toolCalls.length === 0) return

    const resultBlocks: ContentBlock[] = []
    for (const call of toolCalls) {
      const input = inputByCallId.get(call.id) ?? {}
      const { content, isError } = await runTool(call.name, input, sender, {
        streamId,
        sessionId,
        toolUseId: call.id
      })
      resultBlocks.push({ type: 'tool_result', toolUseId: call.id, content, isError })
      emit(sender, {
        streamId,
        sessionId,
        event: { type: 'tool_result', toolUseId: call.id, content, isError }
      })
    }
    insertMessage(sessionId, 'user', resultBlocks)
    conversation.push({ role: 'user', content: resultBlocks })
  }

  emit(sender, {
    streamId,
    sessionId,
    event: { type: 'error', message: `Stopped after ${MAX_TOOL_ROUNDS} tool-call rounds.` }
  })
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  sender: WebContents,
  ctx: { streamId: string; sessionId: string; toolUseId: string }
): Promise<{ content: string; isError: boolean }> {
  const tool = toolRegistry.get(name)
  if (!tool) {
    return { content: `Unknown tool "${name}".`, isError: true }
  }

  if (tool.mutates) {
    const decision = await requestToolConfirmation(sender, {
      streamId: ctx.streamId,
      sessionId: ctx.sessionId,
      toolUseId: ctx.toolUseId,
      name: tool.name,
      input,
      description: tool.describe?.(input) ?? JSON.stringify(input)
    })
    if (!decision.approved) {
      return { content: 'The user denied this tool call.', isError: true }
    }
    input = decision.input ?? input
  }

  try {
    const content = await tool.execute(input, toolContext!)
    return { content, isError: false }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}
