import { listConnections, updateConnectionSchemaSummary } from '../../data/connections'
import type { Tool } from '../types'
import { openDriver } from './driver-factory'
import { buildSchemaSummary, formatSchemaSummary } from './schema-summary'
import { isMutatingSql } from './sql-classifier'

export { dbListRowsTool, dbCountRowsTool, dbFindRowsTool } from './crud'
export { dbSaveQueryTool } from './save-query-tool'

export const dbListConnectionsTool: Tool = {
  name: 'db_list_connections',
  description:
    'List the data connections configured in Settings > Data sources, by name, engine, and a quick ' +
    'table-name hint (no credentials) — use the hint to pick the right connection when there are ' +
    'several, before calling db_introspect_schema on the one you choose (this hint has no columns and ' +
    'can be stale).',
  inputSchema: { type: 'object', properties: {} },
  mutates: false,
  async execute() {
    const connections = listConnections()
    if (!connections.length) {
      return 'No data connections configured yet. Ask the user to add one in Settings > Data sources.'
    }
    // The name is quoted — not just space-separated from `(engine)` — because a connection's own
    // name is free text (Settings has no restriction against it) and can itself contain parentheses,
    // e.g. "Northwind (Docker)". Found live: unquoted, that produced the line
    // "- Northwind (Docker) (mssql): ..." — genuinely ambiguous between the name being "Northwind" or
    // "Northwind (Docker)" — and the model oscillated between both wrong guesses for several rounds
    // before giving up, since db_introspect_schema only ever does an exact match against the real name.
    return connections
      .map((c) => `- "${c.name}" (${c.engine}): ${formatSchemaSummary(c.schemaSummary)}`)
      .join('\n')
  }
}

export const dbIntrospectSchemaTool: Tool = {
  name: 'db_introspect_schema',
  description: 'List tables and columns for a configured data connection.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from db_list_connections' }
    },
    required: ['connection']
  },
  mutates: false,
  async execute(input) {
    const connectionNameOrId = String(input.connection ?? '')
    const driver = openDriver(connectionNameOrId)
    try {
      const tables = await driver.introspectSchema()
      // Opportunistic refresh — keeps db_list_connections' routing hint from
      // going stale forever, at zero extra query cost, piggybacked on
      // introspection the agent was already doing for its own reasons.
      const dto = listConnections().find((c) => c.id === connectionNameOrId || c.name === connectionNameOrId)
      if (dto) updateConnectionSchemaSummary(dto.id, buildSchemaSummary(tables))

      if (!tables.length) return '(no tables found)'
      return tables
        .map((t) => `${t.name}(${t.columns.map((c) => `${c.name}: ${c.type}`).join(', ')})`)
        .join('\n')
    } finally {
      await driver.close()
    }
  }
}

export const dbExecuteSqlTool: Tool = {
  name: 'db_execute_sql',
  description:
    'Run SQL against a configured data connection. Reads run immediately; writes ' +
    '(INSERT/UPDATE/DELETE/DDL, or multiple statements) require approval first.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from db_list_connections' },
      sql: { type: 'string', description: 'The SQL to execute' }
    },
    required: ['connection', 'sql']
  },
  mutates: (input) => isMutatingSql(String(input.sql ?? '')),
  describe(input) {
    return `Execute SQL on "${String(input.connection ?? '')}": ${String(input.sql ?? '')}`
  },
  async execute(input) {
    const driver = openDriver(String(input.connection ?? ''))
    try {
      const result = await driver.execute(String(input.sql ?? ''))
      if (result.rows) {
        return `${result.rowCount} row(s):\n${JSON.stringify(result.rows, null, 2)}`
      }
      return `${result.rowCount} row(s) affected.`
    } finally {
      await driver.close()
    }
  }
}
