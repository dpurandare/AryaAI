import { listConnections, resolveConnection } from '../../data/connections'
import type { Tool } from '../types'
import { PostgresDriver } from './postgres-driver'
import { SqliteDriver } from './sqlite-driver'
import { isMutatingSql } from './sql-classifier'
import type { DbDriver } from './types'

function openDriver(connectionName: string): DbDriver {
  const conn = resolveConnection(connectionName)
  if (!conn) {
    throw new Error(`Unknown data connection "${connectionName}". Call db_list_connections to see what's configured.`)
  }
  if (conn.engine === 'sqlite') return new SqliteDriver(conn.filePath)
  return new PostgresDriver(conn)
}

export const dbListConnectionsTool: Tool = {
  name: 'db_list_connections',
  description: 'List the data connections configured in Settings > Data sources, by name and engine (no credentials).',
  inputSchema: { type: 'object', properties: {} },
  mutates: false,
  async execute() {
    const connections = listConnections()
    if (!connections.length) {
      return 'No data connections configured yet. Ask the user to add one in Settings > Data sources.'
    }
    return connections.map((c) => `- ${c.name} (${c.engine})`).join('\n')
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
    const driver = openDriver(String(input.connection ?? ''))
    try {
      const tables = await driver.introspectSchema()
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
