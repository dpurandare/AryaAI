import type { DataConnectionSchemaSummary } from '@shared/ipc-contract'
import type { DbTable } from './types'

// Table names only, not columns — enough for db_list_connections to help
// the Data agent pick the right connection out of several, without
// bloating that call's output (sent to the model every time it's called)
// the way full column lists would. Capped so one connection with an
// unusually large number of tables can't dominate the output either.
const MAX_TABLES_IN_SUMMARY = 25

export function buildSchemaSummary(tables: DbTable[]): DataConnectionSchemaSummary {
  const names = tables.map((t) => t.name)
  return {
    tables: names.slice(0, MAX_TABLES_IN_SUMMARY),
    truncated: names.length > MAX_TABLES_IN_SUMMARY,
    updatedAt: Date.now()
  }
}

export function formatSchemaSummary(summary: DataConnectionSchemaSummary | undefined): string {
  if (!summary || summary.tables.length === 0) return '(schema not yet known)'
  const suffix = summary.truncated ? ', …' : ''
  return summary.tables.join(', ') + suffix
}
