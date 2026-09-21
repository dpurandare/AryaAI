import { describe, expect, it } from 'vitest'
import { buildFindSelect, buildPagedSelect } from './crud'

/**
 * Regression coverage for a real bug found live while adding SQL Server
 * support (#76): this used to hardcode a literal `?` regardless of engine,
 * which never actually worked against a real Postgres connection —
 * confirmed against a real Postgres container: `syntax error at or near
 * "OFFSET"`, since Postgres's wire protocol has no `?` placeholder syntax
 * at all. Adding a 3rd engine also surfaced a deeper issue LIMIT/OFFSET
 * placeholder-swapping alone can't fix: T-SQL has no LIMIT/OFFSET keywords
 * at all, so mssql needs a genuinely different query shape, not just a
 * different placeholder marker.
 */
describe('buildPagedSelect (db_list_rows)', () => {
  it('sqlite: LIMIT/OFFSET with ? placeholders, limit then offset', () => {
    expect(buildPagedSelect('sqlite', '"t"', 10, 20)).toEqual({
      sql: 'SELECT * FROM "t" LIMIT ? OFFSET ?',
      params: [10, 20]
    })
  })

  it('postgres: LIMIT/OFFSET with $1/$2 placeholders, limit then offset — the confirmed-broken case', () => {
    expect(buildPagedSelect('postgres', '"t"', 10, 20)).toEqual({
      sql: 'SELECT * FROM "t" LIMIT $1 OFFSET $2',
      params: [10, 20]
    })
  })

  it('mssql: OFFSET/FETCH with a dummy ORDER BY (required by T-SQL), offset then limit', () => {
    expect(buildPagedSelect('mssql', '"t"', 10, 20)).toEqual({
      sql: 'SELECT * FROM "t" ORDER BY (SELECT NULL) OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY',
      params: [20, 10]
    })
  })
})

describe('buildFindSelect (db_find_rows)', () => {
  it('sqlite: trailing LIMIT with a ? placeholder', () => {
    expect(buildFindSelect('sqlite', '"t"', '"col"', 50)).toBe('SELECT * FROM "t" WHERE "col" = ? LIMIT 50')
  })

  it('postgres: trailing LIMIT with a $1 placeholder', () => {
    expect(buildFindSelect('postgres', '"t"', '"col"', 50)).toBe('SELECT * FROM "t" WHERE "col" = $1 LIMIT 50')
  })

  it('mssql: TOP n before the column list, no ORDER BY needed', () => {
    expect(buildFindSelect('mssql', '"t"', '"col"', 50)).toBe('SELECT TOP 50 * FROM "t" WHERE "col" = @p1')
  })
})
