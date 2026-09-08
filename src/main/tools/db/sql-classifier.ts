/**
 * Decides whether a piece of SQL needs human confirmation before running.
 * Deliberately conservative (defaults to "mutating" when unsure) rather
 * than a strict allowlist — a naive "check only the leading keyword"
 * classifier has two real bypasses this scans for instead:
 *
 *  - Writable CTEs: `WITH x AS (DELETE FROM foo RETURNING *) SELECT * FROM x`
 *    starts with WITH (reads as a SELECT) but deletes rows.
 *  - Statement stacking: `SELECT 1; DROP TABLE users;` — node-postgres's
 *    simple query protocol (used whenever query() is called with no
 *    parameters) runs multiple ';'-separated statements in one round trip.
 *    better-sqlite3's prepare() rejects multi-statement input by
 *    construction, so this bypass is Postgres-specific, but the classifier
 *    is shared by both drivers.
 */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|GRANT|REVOKE|MERGE|VACUUM|ATTACH|DETACH)\b/i

export function isMutatingSql(sql: string): boolean {
  if (WRITE_KEYWORDS.test(sql)) return true
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  return statements.length > 1
}
