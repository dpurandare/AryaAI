import { resolveApiConnection } from '../../data/api-connections'
import type { Tool } from '../types'
import { formatBody, performRequest } from './client'
import { extractItems, nextPageUrl } from './pagination'

const DEFAULT_MAX_PAGES = 5
const HARD_MAX_PAGES = 20
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Status values that mean "still running" on a job-style response body — see asyncHint below. */
const PENDING_STATUSES = new Set(['pending', 'queued', 'in_progress', 'running', 'processing', 'accepted'])

function methodOf(input: Record<string, unknown>): string {
  return String(input.method ?? 'GET').toUpperCase()
}

/**
 * Recognizes the two common shapes of "this call kicked off a job, it
 * hasn't actually finished yet" — a bare 202 status, or a 2xx body that
 * looks like a job record (a pending-ish `status` field alongside an id).
 * Deliberately heuristic, not a protocol: there's no universal standard
 * for async REST APIs the way there is for pagination's Link header, so
 * this only catches the shapes that are actually common in the wild
 * rather than trying to be exhaustive.
 */
function asyncHint(status: number, headers: Headers, bodyJson: unknown): string | undefined {
  const location = headers.get('location')
  if (status === 202) {
    return (
      'Status 202 Accepted — this looks like an asynchronous operation.' +
      (location
        ? ` Poll it with api_check_status, statusUrl="${location}".`
        : ' Look for a status/job URL in the response body to poll with api_check_status.')
    )
  }
  if (bodyJson && typeof bodyJson === 'object') {
    const obj = bodyJson as Record<string, unknown>
    const jobStatus = typeof obj.status === 'string' ? obj.status.toLowerCase() : undefined
    const id = obj.id ?? obj.job_id ?? obj.jobId
    if (jobStatus && PENDING_STATUSES.has(jobStatus) && id !== undefined) {
      return (
        `Response body has status="${jobStatus}" and id ${JSON.stringify(id)} — this looks like an ` +
        'asynchronous job still in progress, not a finished result. Use api_check_status to poll it ' +
        '(pass this connection and a statusUrl — either one already in the response body, or a status ' +
        'endpoint you know for this API).'
      )
    }
  }
  return undefined
}

export const apiCallTool: Tool = {
  name: 'api_call',
  description:
    'Make an authenticated HTTP call against a connection configured in Settings > External APIs. ' +
    'GET/HEAD/OPTIONS run immediately; anything else requires confirmation first, same as any other ' +
    'mutating tool call. Set paginate:true to automatically follow a Link "next" header or a common ' +
    '"next"-style JSON field across multiple pages (up to maxPages) instead of hand-driving each page ' +
    "yourself — only works when the response body is a list shape (an array, or one under 'items'/" +
    "'data'/'results'/'records'). If a response looks like an asynchronous job (202 Accepted, or a body " +
    'with a pending-like status and an id), this tells you plainly and you should use api_check_status ' +
    "to poll it rather than assuming it already finished. Use api_introspect first if you don't already " +
    "know this API's endpoints/parameters.",
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from api_list_connections' },
      method: { type: 'string', description: 'HTTP method, default GET' },
      path: { type: 'string', description: "Path relative to the connection's base URL, or a full URL" },
      query: { type: 'object', description: 'Query string parameters' },
      headers: { type: 'object', description: 'Extra request headers' },
      body: { description: 'Request body — an object is sent as JSON, a string is sent as-is' },
      paginate: { type: 'boolean', description: 'Follow pagination automatically (default false)' },
      maxPages: {
        type: 'number',
        description: `Max pages to follow when paginate is true (default ${DEFAULT_MAX_PAGES}, max ${HARD_MAX_PAGES})`
      }
    },
    required: ['connection', 'path']
  },
  mutates: (input) => !SAFE_METHODS.has(methodOf(input)),
  describe(input) {
    return `${methodOf(input)} ${String(input.connection ?? '')} ${String(input.path ?? '')}`
  },
  async execute(input) {
    const connectionName = String(input.connection ?? '')
    const conn = resolveApiConnection(connectionName)
    if (!conn) {
      return `No API connection named "${connectionName}" — check api_list_connections, or ask the user to add one in Settings > External APIs.`
    }

    const method = methodOf(input)
    const query = (input.query as Record<string, unknown> | undefined) ?? undefined
    const headers = (input.headers as Record<string, string> | undefined) ?? undefined
    const path = String(input.path ?? '')

    const first = await performRequest(conn, { method, path, query, headers, body: input.body })

    const hint = asyncHint(first.status, first.headers, first.bodyJson)
    if (hint) {
      return `${first.status} ${first.statusText}\n${formatBody(first.bodyText, first.bodyJson)}\n\n${hint}`
    }

    if (!input.paginate) {
      return `${first.status} ${first.statusText}\n${formatBody(first.bodyText, first.bodyJson)}`
    }

    const maxPages = Math.min(HARD_MAX_PAGES, Math.max(1, Number(input.maxPages) || DEFAULT_MAX_PAGES))
    const allItems: unknown[] = []
    let page = first
    let pageCount = 0
    let sawItemShape = false

    // eslint-disable-next-line no-constant-condition
    while (true) {
      pageCount++
      const items = extractItems(page.bodyJson)
      if (items) {
        sawItemShape = true
        allItems.push(...items)
      }
      if (pageCount >= maxPages) break
      const next = nextPageUrl(page)
      if (!next) break
      // No `query`/`body` on follow-up pages — a Link/next URL already
      // carries its own full query string, and pagination only makes
      // sense chained off a read-style first call to begin with.
      page = await performRequest(conn, { method, path: next, headers })
    }

    if (!sawItemShape) {
      return (
        `${first.status} ${first.statusText}\n${formatBody(first.bodyText, first.bodyJson)}\n\n` +
        "(paginate was requested, but the response body isn't a recognizable list shape (array, or " +
        'items/data/results/records) — returned only the first page.)'
      )
    }

    return `${pageCount} page(s), ${allItems.length} item(s) total:\n${formatBody('', allItems)}`
  }
}
