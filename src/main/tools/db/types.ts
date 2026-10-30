import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface DbColumn {
  name: string
  type: string
}

export interface DbTable {
  name: string
  columns: DbColumn[]
}

export interface DbQueryResult {
  /** Present for a read; omitted for a write, where rowCount is the affected-row count instead. */
  rows?: Record<string, unknown>[]
  rowCount: number
}

export interface DbDriver {
  /** Which positional placeholder style execute()'s params bind against — needed by callers (saved-query-tools.ts, crud.ts) that build parameterized/paginated SQL before calling execute(). */
  readonly engine: 'sqlite' | 'postgres' | 'mssql' | 'mysql'
  introspectSchema(): Promise<DbTable[]>
  /** `params` are bound positionally (`?` for SQLite, `$1..$n` for Postgres) — never string-interpolated into `sql`. */
  execute(sql: string, params?: unknown[]): Promise<DbQueryResult>
  close(): Promise<void>
}

/** Above this many rows, the result goes to a file instead of inline text — see `formatQueryResult`. */
export const DISPLAY_ROW_LIMIT = 200

/**
 * TASKS.md #172: every driver's `execute()` used to silently cap `rows` at 200 while `rowCount` reported
 * the real, uncapped total — found live, the two numbers were formatted together as if `rows` were the
 * complete set ("52704 row(s):" followed by only 200 of them), a confident, wrong claim of completeness.
 * An earlier fix made that truncation *honest* (a clear "N of TOTAL shown, truncated" message) but still
 * returned the large result inline — which means it still became part of the stored message, the
 * conversation array re-sent every round, and a search_history embedding candidate, with only
 * downstream layers (the provider-context trim, `search_history`'s own size skip) stopping it from
 * actually reaching those consumers in full. Found live (user correction, 2026-10-02): large data
 * should never become "context" at any layer in the first place, not be produced and then relied on
 * other code to contain. So now: a result at or under `DISPLAY_ROW_LIMIT` is returned exactly as
 * before (unchanged, byte-for-byte, for every normal-sized query); a larger one is written straight to
 * a workspace file and only a small, honest summary — the real count, a 5-row sample, and the file's
 * path — ever becomes tool-result content. The real data for a later step (Developer, reading it with
 * `open`/`json.load` per its own role prompt) lives only in that file, never in the message/conversation
 * path at all.
 */
export async function formatQueryResult(result: DbQueryResult, workspaceRoot: string | undefined): Promise<string> {
  if (!result.rows) return `${result.rowCount} row(s) affected.`
  if (result.rows.length <= DISPLAY_ROW_LIMIT) {
    return `${result.rowCount} row(s):\n${JSON.stringify(result.rows, null, 2)}`
  }
  const sampleText = `Sample (first 5 of ${result.rowCount}):\n${JSON.stringify(result.rows.slice(0, 5), null, 2)}`
  if (!workspaceRoot) {
    // No workspace to write into — shouldn't happen in the real app (every tool call has one), but a
    // defensive fallback must still be honest rather than silently dropping the rest of the data.
    return `${result.rowCount} row(s) — too large to show inline and no workspace available to export to.\n${sampleText}`
  }
  const relPath = `data/db_export_${randomUUID().slice(0, 8)}.json`
  try {
    await mkdir(path.join(workspaceRoot, 'data'), { recursive: true })
    await writeFile(path.join(workspaceRoot, relPath), JSON.stringify(result.rows, null, 2), 'utf-8')
    return (
      `${result.rowCount} row(s) — too large to show inline. Full result written to ${relPath}: read it ` +
      `from there (open/json.load) for any real computation — never retype these rows. ${sampleText}`
    )
  } catch (err) {
    return `${result.rowCount} row(s) — too large to show inline, and writing the full result to a file failed (${err instanceof Error ? err.message : String(err)}). ${sampleText}`
  }
}
