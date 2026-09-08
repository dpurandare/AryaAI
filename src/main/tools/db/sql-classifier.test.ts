import { describe, expect, it } from 'vitest'
import { isMutatingSql } from './sql-classifier'

describe('isMutatingSql', () => {
  it('treats a plain SELECT as non-mutating', () => {
    expect(isMutatingSql('SELECT * FROM users')).toBe(false)
  })

  it('treats EXPLAIN/SHOW/PRAGMA-style reads as non-mutating', () => {
    expect(isMutatingSql('EXPLAIN SELECT 1')).toBe(false)
    expect(isMutatingSql('PRAGMA table_info(users)')).toBe(false)
  })

  it.each(['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'REPLACE', 'GRANT', 'REVOKE', 'MERGE', 'VACUUM'])(
    'treats %s as mutating',
    (keyword) => {
      expect(isMutatingSql(`${keyword} something`)).toBe(true)
    }
  )

  it('is case-insensitive', () => {
    expect(isMutatingSql('delete from users')).toBe(true)
  })

  it('catches a writable CTE that starts with WITH/SELECT-looking text', () => {
    expect(isMutatingSql('WITH x AS (DELETE FROM foo RETURNING *) SELECT * FROM x')).toBe(true)
  })

  it('treats any multi-statement input as mutating, even if every statement individually looks like a read', () => {
    // Deliberately conservative: verifying every statement in a stack is
    // genuinely a read would need a real SQL parser, not a keyword scan, so
    // any stacked input defaults to requiring confirmation.
    expect(isMutatingSql('SELECT 1; SELECT 2;')).toBe(true)
  })

  it('catches statement stacking that hides a write behind a leading read', () => {
    expect(isMutatingSql('SELECT 1; DROP TABLE users;')).toBe(true)
  })

  it('does not misfire on a write keyword appearing inside a string literal-ish column name', () => {
    // Word-boundary match means this should NOT trigger on a substring like "UPDATED_AT".
    expect(isMutatingSql('SELECT updated_at FROM users')).toBe(false)
  })

  it('ignores a trailing empty statement after a single real one', () => {
    expect(isMutatingSql('SELECT * FROM users;')).toBe(false)
  })
})
