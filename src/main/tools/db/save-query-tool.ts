import { listConnections, saveSavedQuery } from '../../data/connections'
import type { Tool } from '../types'
import { savedQueryToolName } from './saved-query-tools'

const PARAM_TYPES = new Set(['string', 'number'])

interface RawParam {
  name: string
  type: string
}

function parseParams(input: Record<string, unknown>): { name: string; type: 'string' | 'number' }[] {
  const raw = input.params
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('"params" must be an array of {name, type}.')
  return (raw as RawParam[]).map((p) => {
    if (!p || typeof p.name !== 'string' || !p.name) {
      throw new Error('Each param needs a non-empty "name".')
    }
    if (!PARAM_TYPES.has(p.type)) {
      throw new Error(`Param "${p.name}" has type "${String(p.type)}" — must be "string" or "number".`)
    }
    return { name: p.name, type: p.type as 'string' | 'number' }
  })
}

/**
 * The runtime equivalent of db_tools.py's hand-written KPI helper functions
 * in the reference EnergyAIProto2 app (plant_load_factor(),
 * capacity_utilization_factor(), etc.) — a curated, reusable query the Data
 * agent doesn't have to re-derive on every matching question. That
 * reference app can hardcode them as source because its two databases are
 * fixed and known at build time; this app's connections are added by the
 * user at runtime, so the *agent* plays the role a developer plays there,
 * authoring the query once it has actually worked one out and confirmed it
 * answers the question — not proactively for hypothetical future
 * questions.
 *
 * Deliberately not settings-managed and has no corresponding UI: this tool
 * is the only way a saved query is ever created (see data/connections.ts's
 * module comment). `mutates: true` so a human still approves each one, the
 * same way any other tool that persists something does.
 */
export const dbSaveQueryTool: Tool = {
  name: 'db_save_query',
  description:
    'Save a working, parametric SQL query as its own reusable tool for a data connection, so a similar ' +
    "future question can call it directly instead of you writing equivalent SQL again. Only save a query " +
    'you have already run and confirmed answers the question correctly — not speculatively. Use `:name` ' +
    'placeholders in the SQL for anything that should vary per call (e.g. `WHERE status = :status`), and ' +
    'declare each one in `params`.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from db_list_connections' },
      name: { type: 'string', description: 'Short identifier, e.g. "orders_by_status"' },
      description: {
        type: 'string',
        description: "What this answers — you'll see this description again next time, to decide whether to reuse it"
      },
      sql: { type: 'string', description: 'The SQL, with :name placeholders for anything parametric' },
      params: {
        type: 'array',
        description: 'One entry per :name placeholder actually used in sql',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, type: { type: 'string', enum: ['string', 'number'] } },
          required: ['name', 'type']
        }
      }
    },
    required: ['connection', 'name', 'description', 'sql']
  },
  mutates: true,
  describe(input) {
    return `Save query "${String(input.name ?? '')}" on "${String(input.connection ?? '')}": ${String(input.sql ?? '')}`
  },
  async execute(input, ctx) {
    const connectionNameOrId = String(input.connection ?? '')
    const connection = listConnections().find((c) => c.id === connectionNameOrId || c.name === connectionNameOrId)
    if (!connection) {
      throw new Error(`Unknown data connection "${connectionNameOrId}". Call db_list_connections first.`)
    }

    const saved = saveSavedQuery({
      connectionId: connection.id,
      name: String(input.name ?? ''),
      description: String(input.description ?? ''),
      sql: String(input.sql ?? ''),
      params: parseParams(input)
    })

    ctx.registerSavedQuery?.(saved)

    return (
      `Saved. It's now available as the tool "${savedQueryToolName(saved)}" — call it directly (with its ` +
      `declared parameters) instead of writing this SQL again next time.`
    )
  }
}
