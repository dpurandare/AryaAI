import { describe, expect, it } from 'vitest'
import { bindNamedParams, namedParamsIn } from './param-binding'

describe('bindNamedParams', () => {
  it('binds a single named param for sqlite (? placeholder)', () => {
    const { sql, params } = bindNamedParams('SELECT * FROM users WHERE id = :id', { id: 42 }, 'sqlite')
    expect(sql).toBe('SELECT * FROM users WHERE id = ?')
    expect(params).toEqual([42])
  })

  it('binds multiple named params for postgres ($1, $2 in order of occurrence)', () => {
    const { sql, params } = bindNamedParams(
      'SELECT * FROM orders WHERE status = :status AND created_at > :since',
      { status: 'paid', since: '2026-01-01' },
      'postgres'
    )
    expect(sql).toBe('SELECT * FROM orders WHERE status = $1 AND created_at > $2')
    expect(params).toEqual(['paid', '2026-01-01'])
  })

  it('binds the same named param reused twice, once per occurrence', () => {
    const { sql, params } = bindNamedParams('SELECT :x + :x AS doubled', { x: 5 }, 'sqlite')
    expect(sql).toBe('SELECT ? + ? AS doubled')
    expect(params).toEqual([5, 5])
  })

  it('does not mistake a postgres type cast (::text) for a placeholder', () => {
    const { sql, params } = bindNamedParams("SELECT amount::text AS s WHERE id = :id", { id: 1 }, 'postgres')
    expect(sql).toBe('SELECT amount::text AS s WHERE id = $1')
    expect(params).toEqual([1])
  })

  it('throws a clear error for a placeholder with no supplied value', () => {
    expect(() => bindNamedParams('SELECT * FROM t WHERE id = :id', {}, 'sqlite')).toThrow(/:id/)
  })

  it('leaves SQL with no placeholders untouched', () => {
    const { sql, params } = bindNamedParams('SELECT COUNT(*) FROM users', {}, 'sqlite')
    expect(sql).toBe('SELECT COUNT(*) FROM users')
    expect(params).toEqual([])
  })
})

describe('namedParamsIn', () => {
  it('lists distinct placeholder names in first-occurrence order', () => {
    expect(namedParamsIn('WHERE a = :foo AND b = :bar AND c = :foo')).toEqual(['foo', 'bar'])
  })

  it('ignores a postgres cast, but still finds a real placeholder with the same name elsewhere', () => {
    expect(namedParamsIn('SELECT x::text WHERE y = :text')).toEqual(['text'])
  })

  it('returns an empty list for SQL with no placeholders', () => {
    expect(namedParamsIn('SELECT COUNT(*) FROM users')).toEqual([])
  })
})
