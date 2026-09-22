import { randomUUID } from 'node:crypto'
import type { EmailConnectionDto, EmailProvider, SaveEmailConnectionInput } from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { deleteApiKey, getApiKey, setApiKey } from '../security/keychain'

/**
 * Email-connection metadata (everything except the app password) is
 * stored as one JSON array under a single settings key — the same
 * pattern already used for data/API/MCP connections. The app password
 * goes through the existing keychain/`.env` store, keyed `email:<id>`,
 * exactly like a Postgres connection's password.
 */
const SETTINGS_KEY = 'emailConnections'
const KEYCHAIN_PREFIX = 'email:'
/** A single settings value holding the default connection's id — not a per-connection flag, so "make this one the default" is a one-key write instead of rewriting every row. Empty/missing means no *explicit* default is set (see resolveDefaultId). */
const DEFAULT_CONNECTION_SETTING_KEY = 'defaultEmailConnectionId'

/** Every connection saved before the `provider` field existed predates it entirely — read back as Gmail, the only provider that ever existed then, rather than losing/breaking an already-working account. */
const DEFAULT_PROVIDER: EmailProvider = 'gmail'

/** Metadata plus the resolved secret — what send_email actually needs. Never persisted as a unit; the secret is looked up from the keychain/.env fresh each time. */
export interface ResolvedEmailConnection {
  id: string
  name: string
  emailAddress: string
  provider: EmailProvider
  /** `custom` only. */
  host?: string
  port?: number
  secure?: boolean
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

/**
 * The connection `send_email` uses when the caller doesn't name one:
 * whatever was explicitly set via setDefaultEmailConnection, unless that
 * connection has since been deleted (deleteEmailConnection clears the
 * setting itself, but this guards the same case defensively) — falling
 * back to the sole configured connection when there's exactly one, so a
 * single-account setup (like most people's) never needs an explicit
 * "set default" step at all. Two-or-more accounts with no explicit choice
 * yields undefined — ambiguous on purpose, not a guess.
 */
function resolveDefaultId(list: EmailConnectionDto[]): string | undefined {
  const explicit = getSetting(DEFAULT_CONNECTION_SETTING_KEY)
  if (explicit && list.some((c) => c.id === explicit)) return explicit
  return list.length === 1 ? list[0].id : undefined
}

export function listEmailConnections(): EmailConnectionDto[] {
  const list = readList()
  const defaultId = resolveDefaultId(list)
  return list.map((c) => ({ ...c, isDefault: c.id === defaultId }))
}

export function getDefaultEmailConnectionId(): string | undefined {
  return resolveDefaultId(readList())
}

export function setDefaultEmailConnection(id: string): void {
  if (!readList().some((c) => c.id === id)) {
    throw new Error(`Unknown email connection "${id}".`)
  }
  setSetting(DEFAULT_CONNECTION_SETTING_KEY, id)
}

export function saveEmailConnection(input: SaveEmailConnectionInput): EmailConnectionDto {
  const list = readList()
  const id = input.id ?? randomUUID()
  const existing = list.find((c) => c.id === id)
  const hasSecret = input.appPassword ? true : (existing?.hasSecret ?? false)

  const provider = input.provider ?? existing?.provider ?? DEFAULT_PROVIDER
  const dto: EmailConnectionDto = {
    id,
    name: input.name,
    emailAddress: input.emailAddress,
    provider,
    ...(provider === 'custom'
      ? { host: input.host ?? existing?.host, port: input.port ?? existing?.port, secure: input.secure ?? existing?.secure }
      : {}),
    hasSecret,
    isDefault: false // computed below, against the post-write list — a stale value here would be wrong the instant this is the first (and so automatically sole-default) connection
  }

  if (input.appPassword) {
    setApiKey(KEYCHAIN_PREFIX + id, input.appPassword)
  }

  const newList = [...list.filter((c) => c.id !== id), dto]
  writeList(newList)
  dto.isDefault = resolveDefaultId(newList) === id
  return dto
}

export function deleteEmailConnection(id: string): void {
  writeList(readList().filter((c) => c.id !== id))
  deleteApiKey(KEYCHAIN_PREFIX + id)
  // Never leave the default setting pointing at a connection that no
  // longer exists — resolveDefaultId already guards against this
  // defensively too, but clearing it here keeps the stored setting itself
  // honest, not just its effective behavior.
  if (getSetting(DEFAULT_CONNECTION_SETTING_KEY) === id) setSetting(DEFAULT_CONNECTION_SETTING_KEY, '')
}

function resolveDto(dto: EmailConnectionDto | undefined): ResolvedEmailConnection | undefined {
  if (!dto) return undefined
  const appPassword = getApiKey(KEYCHAIN_PREFIX + dto.id)
  if (!appPassword) return undefined
  return {
    id: dto.id,
    name: dto.name,
    emailAddress: dto.emailAddress,
    provider: dto.provider ?? DEFAULT_PROVIDER,
    host: dto.host,
    port: dto.port,
    secure: dto.secure,
    appPassword
  }
}

/** Looked up by id or by name (the email role addresses a connection by its human-readable name, same as db/api connections). */
export function resolveEmailConnection(nameOrId: string): ResolvedEmailConnection | undefined {
  return resolveDto(findDto(nameOrId))
}

/** What `send_email` falls back to when no connection is named — see resolveDefaultId for exactly when that's unambiguous. */
export function resolveDefaultEmailConnection(): ResolvedEmailConnection | undefined {
  const list = readList()
  const id = resolveDefaultId(list)
  return resolveDto(list.find((c) => c.id === id))
}
