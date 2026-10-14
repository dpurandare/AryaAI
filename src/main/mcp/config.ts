import { randomUUID } from 'node:crypto'
import { MCP_SERVER_DESCRIPTION_MAX, type McpTransport, type SaveMcpServerInput } from '@shared/ipc-contract'
import { getSetting, setSetting } from '../db/settings'
import { deleteApiKey, getApiKey, setApiKey } from '../security/keychain'

/**
 * MCP server metadata (everything except the optional bearer token) is
 * stored as one JSON array under a single settings key — the same pattern
 * already used for data connections. The token (HTTP transport only) goes
 * through the existing keychain store, keyed `mcp:<id>`, exactly like a
 * Postgres connection's password.
 */
const SETTINGS_KEY = 'mcpServers'
const KEYCHAIN_PREFIX = 'mcp:'

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  hasToken?: boolean
  /** User-written, capped one-liner about what the server is for (see MCP_SERVER_DESCRIPTION_MAX). */
  description?: string
}

/** Trims and length-caps a description; empty becomes undefined. Applied on every write so nothing over the cap is ever stored. */
export function normalizeServerDescription(text: string | undefined): string | undefined {
  const t = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MCP_SERVER_DESCRIPTION_MAX)
  return t || undefined
}

function readList(): McpServerConfig[] {
  const raw = getSetting(SETTINGS_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as McpServerConfig[]
  } catch {
    return []
  }
}

function writeList(list: McpServerConfig[]): void {
  setSetting(SETTINGS_KEY, JSON.stringify(list))
}

export function listServerConfigs(): McpServerConfig[] {
  return readList()
}

/** Throws if `name` collides with a different server — it doubles as the tool-name namespace, so it must stay unique. */
export function saveServerConfig(input: SaveMcpServerInput): McpServerConfig {
  const list = readList()
  const id = input.id ?? randomUUID()

  if (list.some((s) => s.id !== id && s.name === input.name)) {
    throw new Error(`An MCP server named "${input.name}" already exists.`)
  }

  const existing = list.find((s) => s.id === id)
  const hasToken = input.token ? true : (existing?.hasToken ?? false)

  const description = normalizeServerDescription(input.description)
  const config: McpServerConfig =
    input.transport === 'stdio'
      ? { id, name: input.name, transport: 'stdio', command: input.command ?? '', args: input.args ?? [], env: input.env, description }
      : { id, name: input.name, transport: 'http', url: input.url ?? '', hasToken, description }

  if (input.transport === 'http' && input.token) {
    setApiKey(KEYCHAIN_PREFIX + id, input.token)
  }

  writeList([...list.filter((s) => s.id !== id), config])
  return config
}

export function deleteServerConfig(id: string): void {
  writeList(readList().filter((s) => s.id !== id))
  deleteApiKey(KEYCHAIN_PREFIX + id)
}

export function getServerToken(id: string): string | undefined {
  return getApiKey(KEYCHAIN_PREFIX + id)
}
