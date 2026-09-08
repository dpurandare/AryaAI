import { Client } from 'pg'
import type { DbDriver, DbQueryResult, DbTable } from './types'

const MAX_RETURNED_ROWS = 200
const STATEMENT_TIMEOUT_MS = 10_000

export interface PostgresConfig {
  host: string
  port: number
  database: string
  username: string
  password: string
}

export class PostgresDriver implements DbDriver {
  private readonly client: Client
  private connected = false

  constructor(config: PostgresConfig) {
    this.client = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      // Bounds how long a single model-generated query can run — the one
      // cheap mitigation available for the "arbitrary query on the main
      // process" concern documented in sqlite-driver.ts (Postgres queries
      // are at least async, unlike better-sqlite3's synchronous calls).
      statement_timeout: STATEMENT_TIMEOUT_MS
    })
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.client.connect()
      this.connected = true
    }
  }

  async introspectSchema(): Promise<DbTable[]> {
    await this.ensureConnected()
    const tablesResult = await this.client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    )

    const tables: DbTable[] = []
    for (const row of tablesResult.rows) {
      const columnsResult = await this.client.query<{ column_name: string; data_type: string }>(
        'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['public', row.table_name]
      )
      tables.push({
        name: row.table_name,
        columns: columnsResult.rows.map((c) => ({ name: c.column_name, type: c.data_type }))
      })
    }
    return tables
  }

  async execute(sql: string): Promise<DbQueryResult> {
    await this.ensureConnected()
    const result = await this.client.query(sql)
    if (result.rows && result.rows.length > 0) {
      return { rows: result.rows.slice(0, MAX_RETURNED_ROWS), rowCount: result.rowCount ?? result.rows.length }
    }
    return { rowCount: result.rowCount ?? 0 }
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.end()
  }
}
