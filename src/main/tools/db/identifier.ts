import type { DbEngine } from '@shared/ipc-contract'

/**
 * SQLite, Postgres, and SQL Server (with QUOTED_IDENTIFIER on, the default
 * for every connection this app makes — node-mssql/tedious don't turn it
 * off) all accept the SQL-standard `"..."` identifier quoting. MySQL is the
 * one genuine outlier here: `"..."` is a *string literal* there unless the
 * non-default `ANSI_QUOTES` SQL mode is enabled, which this app has no way
 * to guarantee on a connection it doesn't control the server config of —
 * found while adding MySQL support (#76), not assumed. MySQL's own actual
 * identifier-quote character is a backtick, doubled to escape a literal
 * backtick inside a name, the same escaping shape as the other engines'
 * doubled `"`.
 */
export function quoteIdentifier(name: string, engine: DbEngine = 'sqlite'): string {
  if (engine === 'mysql') return `\`${name.replace(/`/g, '``')}\``
  return `"${name.replace(/"/g, '""')}"`
}
