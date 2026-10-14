import mysql from 'mysql2/promise'
import type { DbDriver, DbQueryResult, DbTable } from './types'

/** TASKS.md #172: raised from a 200-row UX cap to a safety backstop — see sqlite-driver.ts's identical constant for the full reasoning. */
const MAX_SAFETY_ROWS = 100_000
const STATEMENT_TIMEOUT_MS = 10_000

export interface MysqlConfig {
  host: string
  port: number
  database: string
  username: string
  password: string
}

export class MysqlDriver implements DbDriver {
  readonly engine = 'mysql' as const

  private readonly config: MysqlConfig
  private connection: mysql.Connection | undefined

  constructor(config: MysqlConfig) {
    this.config = config
  }

  private async ensureConnected(): Promise<mysql.Connection> {
    if (!this.connection) {
      this.connection = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password
      })
      // No dedicated statement-timeout connection option in mysql2 — set via
      // the same server-side session variable every other MySQL client uses
      // (milliseconds), matching the other two drivers' bound on how long a
      // single model-generated query can run.
      await this.connection.query(`SET SESSION MAX_EXECUTION_TIME=${STATEMENT_TIMEOUT_MS}`)
    }
    return this.connection
  }

  async introspectSchema(): Promise<DbTable[]> {
    const conn = await this.ensureConnected()
    const [tablesRows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = ?',
      ['BASE TABLE']
    )

    const tables: DbTable[] = []
    for (const row of tablesRows as { TABLE_NAME: string }[]) {
      const [columnsRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [row.TABLE_NAME]
      )
      tables.push({
        name: row.TABLE_NAME,
        columns: (columnsRows as { COLUMN_NAME: string; DATA_TYPE: string }[]).map((c) => ({
          name: c.COLUMN_NAME,
          type: c.DATA_TYPE
        }))
      })
    }
    return tables
  }

  async execute(sql: string, params: unknown[] = []): Promise<DbQueryResult> {
    const conn = await this.ensureConnected()
    const [result] = await conn.query(sql, params)
    if (Array.isArray(result)) {
      return { rows: result.slice(0, MAX_SAFETY_ROWS) as Record<string, unknown>[], rowCount: result.length }
    }
    const header = result as mysql.ResultSetHeader
    return { rowCount: header.affectedRows ?? 0 }
  }

  async close(): Promise<void> {
    if (this.connection) await this.connection.end()
  }
}
