import { app, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { IpcChannel, type AppInfo, type ChatStreamEventPayload } from '@shared/ipc-contract'
import { createSession, listSessions, deleteSession } from '../db/sessions'
import { insertMessage, listMessages } from '../db/messages'
import { getSetting, setSetting } from '../db/settings'
import { setApiKey, getApiKey } from '../security/keychain'
import { AnthropicProvider } from '../providers/anthropic'
import { OpenAIProvider } from '../providers/openai'
import type { Message, ModelProvider, StreamEvent } from '../providers/types'

const SYSTEM_PROMPT = "You are Sachiv, a helpful AI assistant running locally on the user's machine."

const PROVIDER_FACTORIES: Record<string, (apiKey: string) => ModelProvider> = {
  anthropic: (key) => new AnthropicProvider(key),
  openai: (key) => new OpenAIProvider(key)
}

const ACTIVE_PROVIDER_KEY = 'activeProviderId'
const DEFAULT_PROVIDER_ID = 'anthropic'

function modelSettingKey(providerId: string): string {
  return `model:${providerId}`
}

/**
 * Central place where every ipcMain.handle/on channel is registered.
 * As agents/providers/tools land, each module registers its own channels
 * here rather than main/index.ts growing a pile of handlers.
 */
export function registerIpcHandlers(): void {
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
}

function emit(sender: WebContents, payload: ChatStreamEventPayload): void {
  sender.send(IpcChannel.ChatStreamEvent, payload)
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

  const history = listMessages(sessionId)
  const conversation: Message[] = history.map((m) => ({ role: m.role, content: m.content }))
  conversation.push({ role: 'user', content: [{ type: 'text', text }] })
  insertMessage(sessionId, 'user', [{ type: 'text', text }])

  const provider = factory(apiKey)
  let assistantText = ''

  for await (const event of provider.stream({
    model,
    system: SYSTEM_PROMPT,
    messages: conversation,
    maxTokens: 4096
  })) {
    if (event.type === 'text_delta') assistantText += event.text
    emit(sender, { streamId, sessionId, event: event as StreamEvent })
  }

  insertMessage(sessionId, 'assistant', [{ type: 'text', text: assistantText }])
}
