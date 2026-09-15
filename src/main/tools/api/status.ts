import { resolveApiConnection } from '../../data/api-connections'
import type { Tool } from '../types'
import { formatBody, performRequest, type ApiResponseResult } from './client'

const DEFAULT_MAX_ATTEMPTS = 5
const HARD_MAX_ATTEMPTS = 10
const DEFAULT_INTERVAL_MS = 2000
const MAX_INTERVAL_MS = 10_000
// Wall-clock cap across the whole call, independent of maxAttempts *
// intervalMs — this runs synchronously inside one tool call/chat turn, so
// it must never be allowed to block for minutes regardless of what the
// model asks for.
const TOTAL_BUDGET_MS = 25_000

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled'])
const TERMINAL_SUCCESS_STATUSES = new Set(['succeeded', 'success', 'completed', 'done', 'finished'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function statusOf(bodyJson: unknown): string | undefined {
  if (!bodyJson || typeof bodyJson !== 'object') return undefined
  const value = (bodyJson as Record<string, unknown>).status
  return typeof value === 'string' ? value.toLowerCase() : undefined
}

export const apiCheckStatusTool: Tool = {
  name: 'api_check_status',
  description:
    'Poll the status of an asynchronous operation previously started via api_call (a 202 response, or ' +
    "a job-style body with a pending status and an id). Polls a bounded number of times within this " +
    "one call — if it's still pending when that budget runs out, says so plainly and returns the same " +
    'statusUrl so you can call this again on a later turn rather than blocking indefinitely. A status ' +
    'other than a recognized pending/succeeded/failed value is treated as terminal (returned as-is) ' +
    "rather than polled forever, since not every API uses the same status vocabulary.",
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from api_list_connections' },
      statusUrl: {
        type: 'string',
        description: "The status/job URL to poll — absolute, or relative to the connection's base URL"
      },
      maxAttempts: {
        type: 'number',
        description: `Max polls this call makes (default ${DEFAULT_MAX_ATTEMPTS}, max ${HARD_MAX_ATTEMPTS})`
      },
      intervalMs: {
        type: 'number',
        description: `Delay between polls in ms (default ${DEFAULT_INTERVAL_MS}, max ${MAX_INTERVAL_MS})`
      }
    },
    required: ['connection', 'statusUrl']
  },
  mutates: false,
  async execute(input) {
    const connectionName = String(input.connection ?? '')
    const conn = resolveApiConnection(connectionName)
    if (!conn) {
      return `No API connection named "${connectionName}" — check api_list_connections.`
    }
    const statusUrl = String(input.statusUrl ?? '')
    if (!statusUrl) throw new Error('No statusUrl given.')

    const maxAttempts = Math.min(HARD_MAX_ATTEMPTS, Math.max(1, Number(input.maxAttempts) || DEFAULT_MAX_ATTEMPTS))
    const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(100, Number(input.intervalMs) || DEFAULT_INTERVAL_MS))

    const start = Date.now()
    let last: ApiResponseResult | undefined
    for (let attempt = 1; attempt <= maxAttempts && Date.now() - start < TOTAL_BUDGET_MS; attempt++) {
      last = await performRequest(conn, { method: 'GET', path: statusUrl })
      const status = statusOf(last.bodyJson)
      if (!status || TERMINAL_SUCCESS_STATUSES.has(status) || TERMINAL_FAILURE_STATUSES.has(status)) {
        return `${last.status} ${last.statusText}${status ? ` (job status: ${status})` : ''}\n${formatBody(last.bodyText, last.bodyJson)}`
      }
      if (attempt < maxAttempts) await sleep(intervalMs)
    }

    return (
      `Still pending after ${maxAttempts} poll(s) (job status: ${statusOf(last?.bodyJson) ?? 'unknown'}). ` +
      `Not finished yet — call api_check_status again later with the same statusUrl ("${statusUrl}") to keep checking.`
    )
  }
}
