import { randomUUID } from 'node:crypto'
import type { EmailConnectionDto, SaveEmailConnectionInput } from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { deleteApiKey, getApiKey, setApiKey } from '../security/keychain'

/**
 * Email-connection metadata (everything except the app password) is
 * stored as one JSON array under a single settings key — the same
 * pattern already used for data/API/MCP connections. The app password
 * goes through the existing keychain/`.env` store, keyed `email:<id>`,
 * exactly like a Postgres connection's password (#79 phase 1: Gmail only,
 * app-password auth — see TASKS.md #79 for why Outlook is a separate,
 * not-yet-built OAuth2 path).
 */
const SETTINGS_KEY = 'emailConnections'
const KEYCHAIN_PREFIX = 'email:'

/** Metadata plus the resolved secret — what send_email actually needs. Never persisted as a unit; the secret is looked up from the keychain/.env fresh each time. */
export interface ResolvedEmailConnection {
  id: string
  name: string
  emailAddress: string
  appPassword: string
}

function readList(): EmailConnectionDto[] {
  const raw = getSetting(SETTINGS_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as EmailConnectionDto[]
  } catch {
    return []
  }
}

function writeList(list: EmailConnectionDto[]): void {
  setSetting(SETTINGS_KEY, JSON.stringify(list))
}

function findDto(nameOrId: string): EmailConnectionDto | undefined {
  return readList().find((c) => c.id === nameOrId || c.name === nameOrId)
}

export function listEmailConnections(): EmailConnectionDto[] {
  return readList()
}

export function saveEmailConnection(input: SaveEmailConnectionInput): EmailConnectionDto {
  const list = readList()
  const id = input.id ?? randomUUID()
  const existing = list.find((c) => c.id === id)
  const hasSecret = input.appPassword ? true : (existing?.hasSecret ?? false)

  const dto: EmailConnectionDto = {
    id,
    name: input.name,
    emailAddress: input.emailAddress,
    hasSecret
  }

  if (input.appPassword) {
    setApiKey(KEYCHAIN_PREFIX + id, input.appPassword)
  }

  writeList([...list.filter((c) => c.id !== id), dto])
  return dto
}

export function deleteEmailConnection(id: string): void {
  writeList(readList().filter((c) => c.id !== id))
  deleteApiKey(KEYCHAIN_PREFIX + id)
}

/** Looked up by id or by name (the email role addresses a connection by its human-readable name, same as db/api connections). */
export function resolveEmailConnection(nameOrId: string): ResolvedEmailConnection | undefined {
  const dto = findDto(nameOrId)
  if (!dto) return undefined
  const appPassword = getApiKey(KEYCHAIN_PREFIX + dto.id)
  if (!appPassword) return undefined
  return { id: dto.id, name: dto.name, emailAddress: dto.emailAddress, appPassword }
}
