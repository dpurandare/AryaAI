import type { Tool } from '../types'
import { openDriver } from './driver-factory'
import { quoteIdentifier } from './identifier'
import type { DbDriver, DbTable } from './types'

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const FIND_LIMIT = 50

/**
 * Table/column names come from the model, but can never be bound as query
 * *parameters* the way values can (SQL doesn't allow parameterizing
 * identifiers) — so they're validated against what introspectSchema()
 * actually reports for this connection before being quoted into the SQL
 * text, rather than trusted directly. This is the real, cheap payoff of
 * these tools over the model writing raw SQL: mechanical lookups (list a
 * table, count it, find by one column) never need the model to compose SQL
 * at all, just to name a table/column it already knows from
 * db_introspect_schema.
 */
async function requireTable(driver: DbDriver, tableName: string): Promise<DbTable> {
  const tables = await driver.introspectSchema()
  const table = tables.find((t) => t.name === tableName)
  if (!table) {
    throw new Error(
      `Unknown table "${tableName}". Call db_introspect_schema first to see what's available on this connection.`
    )
  }
  return table
}

function requireColumn(table: DbTable, columnName: string): void {
  if (!table.columns.some((c) => c.name === columnName)) {
    throw new Error(`Table "${table.name}" has no column "${columnName}".`)
  }
}

export const dbListRowsTool: Tool = {
  name: 'db_list_rows',
  description:
    `List rows from a table on a configured data connection, with paging (default limit ${DEFAULT_LIST_LIMIT}, ` +
    `max ${MAX_LIST_LIMIT}) — a mechanical lookup, no SQL to write. Use db_execute_sql instead for anything that ` +
    'needs a WHERE/JOIN/aggregation beyond what db_find_rows already covers.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from db_list_connections' },
      table: { type: 'string', description: 'Table name from db_introspect_schema' },
      limit: { type: 'number', description: `Max rows to return (default ${DEFAULT_LIST_LIMIT})` },
      offset: { type: 'number', description: 'Rows to skip (default 0)' }
    },
    required: ['connection', 'table']
  },
  mutates: false,
  async execute(input) {
    const driver = openDriver(String(input.connection ?? ''))
    try {
      const table = await requireTable(driver, String(input.table ?? ''))
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIST_LIMIT))
      const offset = Math.max(0, Number(input.offset) || 0)
      const result = await driver.execute(`SELECT * FROM ${quoteIdentifier(table.name)} LIMIT ? OFFSET ?`, [
        limit,
        offset
      ])
      return `${result.rowCount} row(s):\n${JSON.stringify(result.rows, null, 2)}`
    } finally {
      await driver.close()
    }
  }
}

export const dbCountRowsTool: Tool = {
  name: 'db_count_rows',
  description: 'Count rows in a table on a configured data connection — a mechanical lookup, no SQL to write.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from db_list_connections' },
      table: { type: 'string', description: 'Table name from db_introspect_schema' }
    },
    required: ['connection', 'table']
  },
  mutates: false,
  async execute(input) {
    const driver = openDriver(String(input.connection ?? ''))
    try {
      const table = await requireTable(driver, String(input.table ?? ''))
      const result = await driver.execute(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`)
      return String((result.rows?.[0] as { count: unknown } | undefined)?.count ?? 0)
    } finally {
      await driver.close()
    }
  }
}

export const dbFindRowsTool: Tool = {
  name: 'db_find_rows',
  description:
    `Find rows in a table where one column equals a value (up to ${FIND_LIMIT} matches) — a mechanical ` +
    'equality lookup, no SQL to write. Use db_execute_sql for anything needing more than one condition.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Connection name from db_list_connections' },
      table: { type: 'string', description: 'Table name from db_introspect_schema' },
      column: { type: 'string', description: 'Column name from db_introspect_schema' },
      value: { description: 'Value the column must equal' }
    },
    required: ['connection', 'table', 'column', 'value']
  },
  mutates: false,
  async execute(input) {
    const driver = openDriver(String(input.connection ?? ''))
    try {
      const table = await requireTable(driver, String(input.table ?? ''))
      const column = String(input.column ?? '')
      requireColumn(table, column)
      const result = await driver.execute(
        `SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(column)} = ? LIMIT ${FIND_LIMIT}`,
        [input.value]
      )
      return `${result.rowCount} row(s):\n${JSON.stringify(result.rows, null, 2)}`
    } finally {
      await driver.close()
    }
  }
}
