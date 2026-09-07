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

  ProvidersSetApiKey: 'providers:set-api-key',
  ProvidersHasApiKey: 'providers:has-api-key',
  ProvidersListModels: 'providers:list-models',

  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',

  ChatSend: 'chat:send',
  ChatStreamEvent: 'chat:stream-event',

  ToolConfirmRequest: 'tools:confirm-request',
  ToolConfirmRespond: 'tools:confirm-respond'
} as const

/** Providers wired into the app. Extend as adapters land (TASKS.md #16-18). */
export const SUPPORTED_PROVIDERS = [
  { id: 'anthropic', displayName: 'Anthropic' },
  { id: 'openai', displayName: 'OpenAI' }
] as const

export type ProviderId = (typeof SUPPORTED_PROVIDERS)[number]['id']

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
