/**
 * Both drivers use the same `"..."` identifier-quoting convention (SQLite
 * and Postgres both follow the SQL standard here, unlike their very
 * different string-literal quoting) — shared so the CRUD tools (crud.ts)
 * and both drivers quote identifiers identically, not two independently
 * maintained copies that could drift.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
