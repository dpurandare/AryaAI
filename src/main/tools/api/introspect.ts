import type { ApiConnectionSpecSummary } from '@shared/ipc-contract'
import { listApiConnections, resolveApiConnection, updateApiConnectionSpecSummary } from '../../data/api-connections'
import type { Tool } from '../types'

// OpenAPI 3 and Swagger 2 both use a top-level `paths` object keyed by
// path, each holding an operation object per HTTP method — close enough
// that one parser covers both without needing to detect which version a
// given spec is.
const WELL_KNOWN_SPEC_PATHS = ['/openapi.json', '/swagger.json', '/v3/api-docs', '/v2/api-docs', '/.well-known/openapi.json']
const MAX_ENDPOINTS = 60
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

interface EndpointInfo {
  method: string
  path: string
  summary?: string
  params: string[]
}

function paramsOf(operation: Record<string, unknown>): string[] {
  const params: string[] = []
  if (Array.isArray(operation.parameters)) {
    for (const p of operation.parameters as unknown[]) {
      const name = p && typeof p === 'object' ? (p as Record<string, unknown>).name : undefined
      if (typeof name === 'string') params.push(name)
    }
  }
  if (operation.requestBody) params.push('(request body)')
  return params
}

function parseSpec(spec: unknown): EndpointInfo[] {
  if (!spec || typeof spec !== 'object' || !('paths' in spec)) return []
  const paths = (spec as { paths: unknown }).paths
  if (!paths || typeof paths !== 'object') return []

  const endpoints: EndpointInfo[] = []
  for (const [path, methodsRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (!methodsRaw || typeof methodsRaw !== 'object') continue
    for (const method of HTTP_METHODS) {
      const operation = (methodsRaw as Record<string, unknown>)[method]
      if (!operation || typeof operation !== 'object') continue
      const op = operation as Record<string, unknown>
      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: typeof op.summary === 'string' ? op.summary : typeof op.description === 'string' ? op.description : undefined,
        params: paramsOf(op)
      })
    }
  }
  return endpoints
}

async function fetchSpec(specUrl: string): Promise<unknown | undefined> {
  try {
    const response = await fetch(specUrl, { headers: { Accept: 'application/json' } })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

export const apiIntrospectTool: Tool = {
  name: 'api_introspect',
  description:
    "Discover a configured API connection's endpoints by fetching and parsing its OpenAPI/Swagger " +
    "spec — the connection's own specUrl if one is configured, otherwise a handful of common " +
    'well-known paths under its base URL. Returns method, path, summary, and parameter names per ' +
    'endpoint so you know what to call before using api_call. If no spec can be found, says so plainly ' +
    'rather than guessing at endpoints — ask the user for documentation or a specific endpoint instead.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from api_list_connections' }
    },
    required: ['connection']
  },
  mutates: false,
  async execute(input) {
    const nameOrId = String(input.connection ?? '')
    const dto = listApiConnections().find((c) => c.id === nameOrId || c.name === nameOrId)
    const resolved = resolveApiConnection(nameOrId)
    if (!dto || !resolved) {
      return `No API connection named "${nameOrId}" — check api_list_connections, or ask the user to add one in Settings > External APIs.`
    }

    const candidates = resolved.specUrl ? [resolved.specUrl] : WELL_KNOWN_SPEC_PATHS.map((p) => resolved.baseUrl + p)

    let endpoints: EndpointInfo[] = []
    let foundAt: string | undefined
    for (const candidate of candidates) {
      const parsed = parseSpec(await fetchSpec(candidate))
      if (parsed.length) {
        endpoints = parsed
        foundAt = candidate
        break
      }
    }

    if (!endpoints.length) {
      return (
        `No OpenAPI/Swagger spec found for "${dto.name}"` +
        (resolved.specUrl ? ` at ${resolved.specUrl}` : ` at any of the common well-known paths under ${resolved.baseUrl}`) +
        ". Ask the user for the API's documentation or a specific endpoint to call, or add a specUrl for " +
        'this connection in Settings if one exists.'
      )
    }

    const truncated = endpoints.length > MAX_ENDPOINTS
    const shown = endpoints.slice(0, MAX_ENDPOINTS)

    const summary: ApiConnectionSpecSummary = {
      endpointCount: endpoints.length,
      sample: shown.slice(0, 10).map((e) => `${e.method} ${e.path}`),
      updatedAt: Date.now()
    }
    updateApiConnectionSpecSummary(dto.id, summary)

    const lines = shown.map((e) => {
      const paramsText = e.params.length ? ` [${e.params.join(', ')}]` : ''
      return `${e.method} ${e.path}${e.summary ? ` — ${e.summary}` : ''}${paramsText}`
    })
    return (
      `Spec found at ${foundAt} (${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}` +
      `${truncated ? `, showing first ${MAX_ENDPOINTS}` : ''}):\n` +
      lines.join('\n')
    )
  }
}
