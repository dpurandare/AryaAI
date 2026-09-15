import type { ResolvedApiConnection } from '../../data/api-connections'

export const DEFAULT_TIMEOUT_MS = 30_000
/** Caps what actually gets handed back to the model — a response can be arbitrarily large; the full raw response was already fetched and is what a real API returned, this is only about not blowing up the conversation with it. */
export const MAX_RESPONSE_CHARS = 20_000

export interface ApiRequestInput {
  method: string
  path: string
  query?: Record<string, unknown>
  headers?: Record<string, string>
  body?: unknown
}

export interface ApiResponseResult {
  status: number
  statusText: string
  headers: Headers
  bodyText: string
  bodyJson: unknown | undefined
}

/**
 * `path` may be a full URL (used as-is, e.g. when following a pagination
 * "next" link) or relative to the connection's base URL. A *leading* slash
 * on a relative path is stripped before resolving against `baseUrl + '/'`
 * — deliberately, so `path: "/users"` against a connection whose base URL
 * already has its own sub-path (e.g. "https://api.example.com/v1") lands
 * at ".../v1/users", not at the origin root, clobbering "/v1". This is the
 * opposite of raw WHATWG URL-resolution semantics for a leading slash, and
 * is the whole reason this isn't just `new URL(path, baseUrl)`.
 */
function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\/+/, ''), baseUrl + '/')
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

export function applyAuth(conn: ResolvedApiConnection, headers: Record<string, string>): void {
  if (conn.authType === 'apiKey' && conn.secret) {
    headers[conn.apiKeyHeader || 'X-API-Key'] = conn.secret
  } else if (conn.authType === 'bearer' && conn.secret) {
    headers.Authorization = `Bearer ${conn.secret}`
  } else if (conn.authType === 'basic' && conn.secret) {
    headers.Authorization = `Basic ${Buffer.from(`${conn.username ?? ''}:${conn.secret}`).toString('base64')}`
  }
}

/** Runs one HTTP call against a connection: builds the URL, applies auth, enforces a timeout, and parses the body as JSON when it is JSON (silently falling back to raw text otherwise — a non-JSON response is not an error). */
export async function performRequest(
  conn: ResolvedApiConnection,
  input: ApiRequestInput,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ApiResponseResult> {
  const headers: Record<string, string> = { Accept: 'application/json', ...input.headers }
  applyAuth(conn, headers)

  let body: string | undefined
  if (input.body !== undefined) {
    const isString = typeof input.body === 'string'
    body = isString ? (input.body as string) : JSON.stringify(input.body)
    if (!headers['Content-Type'] && !isString) headers['Content-Type'] = 'application/json'
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(buildUrl(conn.baseUrl, input.path, input.query), {
      method: input.method,
      headers,
      body,
      signal: controller.signal
    })
    const bodyText = await response.text()
    let bodyJson: unknown
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : undefined
    } catch {
      bodyJson = undefined
    }
    return { status: response.status, statusText: response.statusText, headers: response.headers, bodyText, bodyJson }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms.`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export function truncateForModel(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESPONSE_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_RESPONSE_CHARS), truncated: true }
}

export function formatBody(bodyText: string, bodyJson: unknown): string {
  const raw = bodyJson !== undefined ? JSON.stringify(bodyJson, null, 2) : bodyText
  const { text, truncated } = truncateForModel(raw)
  return truncated ? `${text}\n... (truncated)` : text
}
