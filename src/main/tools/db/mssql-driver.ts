import sql from 'mssql'
import type { DbDriver, DbQueryResult, DbTable } from './types'

/** TASKS.md #172: raised from a 200-row UX cap to a safety backstop — see sqlite-driver.ts's identical constant for the full reasoning. */
const MAX_SAFETY_ROWS = 100_000
const STATEMENT_TIMEOUT_MS = 10_000

export interface MssqlConfig {
  host: string
  port: number
  database: string
  username: string
  password: string
}

/** `@p1, @p2, ...` (see param-binding.ts's positionalPlaceholder) is the one placeholder convention every SQL text this driver receives uses — both crud.ts's hand-built queries and bindNamedParams' saved-query output target it for the `mssql` engine specifically, so this driver can always bind positionally by that fixed naming scheme. */
function paramName(index: number): string {
  return `p${index + 1}`
}

export class MssqlDriver implements DbDriver {
  readonly engine = 'mssql' as const

  private readonly pool: sql.ConnectionPool
  private connected = false

  constructor(config: MssqlConfig) {
    this.pool = new sql.ConnectionPool({
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      requestTimeout: STATEMENT_TIMEOUT_MS,
      options: {
        // Defaults chosen for this app's realistic case (a local/on-prem
        // server, often with a self-signed or no cert) rather than the
        // package's own out-of-the-box default (trustServerCertificate:
        // false) — matches the package's own documented recommendation
        // for local dev, since there's no separate UI field to configure
        // this per connection.
        encrypt: true,
        trustServerCertificate: true
      }
    })
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.pool.connect()
      this.connected = true
    }
  }

  async introspectSchema(): Promise<DbTable[]> {
    await this.ensureConnected()
    const tablesResult = await this.pool
      .request()
      .query<{ TABLE_NAME: string }>("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'")

    const tables: DbTable[] = []
    for (const row of tablesResult.recordset) {
      const columnsResult = await this.pool
        .request()
        .input('p1', sql.NVarChar, row.TABLE_NAME)
        .query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
          'SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @p1'
        )
      tables.push({
        name: row.TABLE_NAME,
        columns: columnsResult.recordset.map((c) => ({ name: c.COLUMN_NAME, type: c.DATA_TYPE }))
      })
    }
    return tables
  }

  async execute(sqlText: string, params: unknown[] = []): Promise<DbQueryResult> {
    await this.ensureConnected()
    const request = this.pool.request()
    params.forEach((value, i) => request.input(paramName(i), value))
    const result = await request.query(sqlText)
    if (result.recordset && result.recordset.length > 0) {
      return { rows: result.recordset.slice(0, MAX_SAFETY_ROWS), rowCount: result.recordset.length }
    }
    const affected = Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((a, b) => a + b, 0) : 0
    return { rowCount: affected }
  }

  async close(): Promise<void> {
    if (this.connected) await this.pool.close()
  }
}
