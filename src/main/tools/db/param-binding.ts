import type { DbEngine } from '@shared/ipc-contract'

/** The one positional-placeholder convention every engine's driver and every caller building parameterized SQL (bindNamedParams below, crud.ts's hand-built queries) agrees on — `index` is 1-based to match how each engine actually numbers/names its own placeholders. */
export function positionalPlaceholder(engine: DbEngine, index: number): string {
  if (engine === 'postgres') return `$${index}`
  if (engine === 'mssql') return `@p${index}`
  return '?'
}

/**
 * A saved query's SQL is authored once (Settings, or a one-time LLM-assisted
 * pass) with named placeholders like `:userId`, then reused across many
 * calls with different values — this is what makes it cheaper than the
 * model writing SQL fresh every time. Values are always bound as real query
 * parameters (SQLite `?`, Postgres `$1..$n`), never string-interpolated
 * into the SQL text, regardless of where the value ultimately came from
 * (a saved-query call's arguments are themselves model-supplied).
 *
 * Deliberately simple, not a real SQL tokenizer: a `:name` immediately
 * preceded by another `:` is skipped so this doesn't mistake a Postgres
 * type cast (`value::text`) for a parameter — but it does NOT understand
 * string literals, so a literal `:like_this` inside a quoted string in the
 * SQL text would also (wrongly) be treated as a placeholder. Documented as
 * a known constraint on how saved queries are authored, not silently
 * handled — a real SQL parser is a lot of complexity for a feature meant
 * to stay simple.
 */
export function bindNamedParams(
  sqlTemplate: string,
  values: Record<string, unknown>,
  engine: DbEngine
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const sql = sqlTemplate.replace(/(:?):([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, precedingColon: string, name: string) => {
    if (precedingColon) return match // "::text" cast, not a ":text" placeholder
    if (!(name in values)) {
      throw new Error(`Missing value for parameter ":${name}".`)
    }
    params.push(values[name])
    return positionalPlaceholder(engine, params.length)
  })
  return { sql, params }
}

/** Every `:name` placeholder actually present in a SQL template, in first-occurrence order — used to validate a saved query's declared params against what its SQL text actually references. */
export function namedParamsIn(sqlTemplate: string): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const match of sqlTemplate.matchAll(/(:?):([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    const [, precedingColon, name] = match
    if (precedingColon || seen.has(name)) continue
    seen.add(name)
    ordered.push(name)
  }
  return ordered
}
