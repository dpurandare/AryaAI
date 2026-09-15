import { randomUUID } from 'node:crypto'
import type { ApiAuthType, ApiConnectionDto, ApiConnectionSpecSummary, SaveApiConnectionInput } from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { deleteApiKey, getApiKey, setApiKey } from '../security/keychain'

/**
 * API-connection metadata (everything except the secret) is stored as one
 * JSON array under a single settings key — the same pattern already used
 * for data connections and MCP servers. The secret (API key / bearer token
 * / basic password) goes through the existing keychain store, keyed
 * `api:<id>`, exactly like a Postgres connection's password.
 */
const SETTINGS_KEY = 'apiConnections'
const KEYCHAIN_PREFIX = 'api:'

/** Metadata plus the resolved secret — what a tool actually needs to make a call. Never persisted as a unit; the secret is looked up from the keychain fresh each time. */
export interface ResolvedApiConnection {
  id: string
  name: string
  baseUrl: string
  authType: ApiAuthType
  apiKeyHeader?: string
  username?: string
  secret?: string
  specUrl?: string
}

function readList(): ApiConnectionDto[] {
  const raw = getSetting(SETTINGS_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as ApiConnectionDto[]
  } catch {
    return []
  }
}

function writeList(list: ApiConnectionDto[]): void {
  setSetting(SETTINGS_KEY, JSON.stringify(list))
}

function findDto(nameOrId: string): ApiConnectionDto | undefined {
  return readList().find((c) => c.id === nameOrId || c.name === nameOrId)
}

export function listApiConnections(): ApiConnectionDto[] {
  return readList()
}

export function getApiConnection(id: string): ApiConnectionDto | undefined {
  return readList().find((c) => c.id === id)
}

export function saveApiConnection(input: SaveApiConnectionInput): ApiConnectionDto {
  const list = readList()
  const id = input.id ?? randomUUID()
  // Preserve the cached spec summary across an edit — a plain "replace the
  // DTO" would otherwise silently wipe it, the same reasoning connections.ts
  // uses for a data connection's saved queries/schema summary.
  const existing = list.find((c) => c.id === id)
  const hasSecret = input.secret ? true : (existing?.hasSecret ?? false)

  const dto: ApiConnectionDto = {
    id,
    name: input.name,
    // Trailing slashes normalized once here so tools/api/client.ts's
    // relative-path resolution (which appends its own "/") never has to
    // worry about a double slash.
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    authType: input.authType,
    apiKeyHeader: input.authType === 'apiKey' ? input.apiKeyHeader?.trim() || 'X-API-Key' : undefined,
    username: input.authType === 'basic' ? input.username : undefined,
    hasSecret,
    specUrl: input.specUrl || undefined,
    specSummary: existing?.specSummary
  }

  if (input.secret) {
    setApiKey(KEYCHAIN_PREFIX + id, input.secret)
  }

  writeList([...list.filter((c) => c.id !== id), dto])
  return dto
}

/** Called by api_introspect once it actually finds and parses a spec — see tools/api/introspect.ts. Never warmed automatically on save (see ApiConnectionSpecSummary's doc comment). A no-op for an unknown connection, same as updateConnectionSchemaSummary's reasoning: a probe racing a delete is a benign, uninteresting outcome. */
export function updateApiConnectionSpecSummary(id: string, summary: ApiConnectionSpecSummary): void {
  const list = readList()
  const idx = list.findIndex((c) => c.id === id)
  if (idx === -1) return
  list[idx] = { ...list[idx], specSummary: summary }
  writeList(list)
}

export function deleteApiConnection(id: string): void {
  writeList(readList().filter((c) => c.id !== id))
  deleteApiKey(KEYCHAIN_PREFIX + id)
}

/** Looked up by id or by name (tools address a connection by its human-readable name, like a data connection). */
export function resolveApiConnection(nameOrId: string): ResolvedApiConnection | undefined {
  const dto = findDto(nameOrId)
  if (!dto) return undefined
  return {
    id: dto.id,
    name: dto.name,
    baseUrl: dto.baseUrl,
    authType: dto.authType,
    apiKeyHeader: dto.apiKeyHeader,
    username: dto.username,
    secret: dto.hasSecret ? getApiKey(KEYCHAIN_PREFIX + dto.id) : undefined,
    specUrl: dto.specUrl
  }
}
