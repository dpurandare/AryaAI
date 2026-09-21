import type { ApiAuthType, SaveApiConnectionInput } from '@shared/ipc-contract'
import { saveApiConnection, type ResolvedApiConnection } from '../../data/api-connections'
import { performRequest } from '../api/client'
import type { Tool } from '../types'

function connectionFromInput(input: Record<string, unknown>): ResolvedApiConnection {
  const authType = String(input.authType ?? 'none') as ApiAuthType
  return {
    id: 'validation-probe',
    name: String(input.name ?? ''),
    baseUrl: String(input.baseUrl ?? '').replace(/\/+$/, ''),
    authType,
    apiKeyHeader: authType === 'apiKey' ? String(input.apiKeyHeader ?? 'X-API-Key') : undefined,
    username: authType === 'basic' ? String(input.username ?? '') : undefined,
    secret:
      authType === 'apiKey'
        ? String(input.apiKey ?? '')
        : authType === 'bearer'
          ? String(input.token ?? '')
          : authType === 'basic'
            ? String(input.password ?? '')
            : undefined
  }
}

/** A lightweight authenticated GET against the base URL — enough to confirm the host is reachable and, if credentials were supplied, that they aren't being outright rejected. Not a full spec probe (that's api_introspect's job, and most APIs have no spec at all). */
async function probeConnection(input: Record<string, unknown>): Promise<void> {
  const conn = connectionFromInput(input)
  if (!conn.baseUrl) throw new Error('baseUrl is required.')
  const result = await performRequest(conn, { method: 'GET', path: '' })
  if (result.status === 401 || result.status === 403) {
    throw new Error(`Server rejected the request (${result.status} ${result.statusText}) — check the credentials.`)
  }
}

export const apiCreateConnectionTool: Tool = {
  name: 'api_create_connection',
  description:
    'Create a new External API connection (Settings > External APIs) directly from details gathered in ' +
    "chat. Gather the non-secret fields yourself (name/baseUrl/authType/apiKeyHeader or username); the " +
    "secret (API key / bearer token / basic-auth password) is entered by the user directly in the " +
    "confirmation dialog, never typed to you — never ask the user to tell you a secret in chat. A " +
    'lightweight authenticated request against baseUrl runs before saving, so an unreachable host or ' +
    'rejected credential is caught immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      baseUrl: { type: 'string' },
      authType: { type: 'string', enum: ['none', 'apiKey', 'bearer', 'basic'] },
      apiKeyHeader: { type: 'string', description: 'apiKey only, default "X-API-Key"' },
      username: { type: 'string', description: 'basic only' },
      apiKey: { type: 'string', description: 'apiKey only — user enters this directly, do not ask for it in chat' },
      token: { type: 'string', description: 'bearer only — user enters this directly, do not ask for it in chat' },
      password: { type: 'string', description: 'basic only — user enters this directly, do not ask for it in chat' },
      specUrl: { type: 'string', description: 'optional OpenAPI/Swagger spec URL' }
    },
    required: ['name', 'baseUrl', 'authType']
  },
  mutates: true,
  secretFields: ['apiKey', 'token', 'password'],
  describe(input) {
    return `Create API connection "${String(input.name ?? '')}" → ${String(input.baseUrl ?? '')} (${String(input.authType ?? 'none')})`
  },
  validate: probeConnection,
  async execute(input) {
    await probeConnection(input)
    const authType = String(input.authType ?? 'none') as ApiAuthType
    const secret =
      authType === 'apiKey'
        ? typeof input.apiKey === 'string'
          ? input.apiKey
          : undefined
        : authType === 'bearer'
          ? typeof input.token === 'string'
            ? input.token
            : undefined
          : authType === 'basic'
            ? typeof input.password === 'string'
              ? input.password
              : undefined
            : undefined
    const saveInput: SaveApiConnectionInput = {
      name: String(input.name ?? ''),
      baseUrl: String(input.baseUrl ?? ''),
      authType,
      apiKeyHeader: typeof input.apiKeyHeader === 'string' ? input.apiKeyHeader : undefined,
      username: typeof input.username === 'string' ? input.username : undefined,
      secret,
      specUrl: typeof input.specUrl === 'string' ? input.specUrl : undefined
    }
    const saved = saveApiConnection(saveInput)
    return `Created and verified API connection "${saved.name}". It now appears in Settings > External APIs and is usable via api_list_connections.`
  }
}
