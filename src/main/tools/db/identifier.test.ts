import { describe, expect, it } from 'vitest'
import { quoteIdentifier } from './identifier'

describe('quoteIdentifier', () => {
  it('sqlite/postgres/mssql all use standard-SQL double quotes, doubled to escape a literal quote', () => {
    expect(quoteIdentifier('users')).toBe('"users"')
    expect(quoteIdentifier('users', 'sqlite')).toBe('"users"')
    expect(quoteIdentifier('users', 'postgres')).toBe('"users"')
    expect(quoteIdentifier('users', 'mssql')).toBe('"users"')
    expect(quoteIdentifier('weird"name', 'postgres')).toBe('"weird""name"')
  })

  it('mysql uses backticks instead — "..." is a string literal there without non-default ANSI_QUOTES mode', () => {
    expect(quoteIdentifier('users', 'mysql')).toBe('`users`')
    expect(quoteIdentifier('weird`name', 'mysql')).toBe('`weird``name`')
  })
})
