import { describe, expect, it } from 'vitest'
import { buildSchemaSummary, formatSchemaSummary } from './schema-summary'

describe('buildSchemaSummary', () => {
  it('lists all table names when under the cap', () => {
    const summary = buildSchemaSummary([
      { name: 'users', columns: [] },
      { name: 'orders', columns: [] }
    ])
    expect(summary.tables).toEqual(['users', 'orders'])
    expect(summary.truncated).toBe(false)
  })

  it('caps at 25 tables and flags truncation', () => {
    const tables = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, columns: [] }))
    const summary = buildSchemaSummary(tables)
    expect(summary.tables).toHaveLength(25)
    expect(summary.truncated).toBe(true)
  })

  it('sets updatedAt to roughly now', () => {
    const before = Date.now()
    const summary = buildSchemaSummary([])
    expect(summary.updatedAt).toBeGreaterThanOrEqual(before)
  })
})

describe('formatSchemaSummary', () => {
  it('shows "not yet known" for an undefined summary', () => {
    expect(formatSchemaSummary(undefined)).toBe('(schema not yet known)')
  })

  it('shows "not yet known" for an empty-tables summary', () => {
    expect(formatSchemaSummary({ tables: [], truncated: false, updatedAt: 0 })).toBe('(schema not yet known)')
  })

  it('joins table names with a comma', () => {
    expect(formatSchemaSummary({ tables: ['users', 'orders'], truncated: false, updatedAt: 0 })).toBe(
      'users, orders'
    )
  })

  it('appends an ellipsis marker when truncated', () => {
    expect(formatSchemaSummary({ tables: ['users'], truncated: true, updatedAt: 0 })).toBe('users, …')
  })
})
