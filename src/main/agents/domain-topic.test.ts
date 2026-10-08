import { describe, expect, it } from 'vitest'
import { isUserDataTopic, userDataTerms } from './domain-topic'

describe('userDataTerms', () => {
  it('keeps whole names and distinctive words, and drops generic parts', () => {
    const terms = userDataTerms(['NorthwindSQLServer', 'kagent_sample', 'db'])
    expect(terms).toContain('northwindsqlserver')
    expect(terms).toContain('northwind')
    expect(terms).toContain('kagent')
    expect(terms).not.toContain('server')
    expect(terms).not.toContain('sample')
    expect(terms).not.toContain('db')
  })
})

describe('isUserDataTopic', () => {
  const terms = userDataTerms(['NorthwindSQLServer', 'kagent_sample'])

  it('rejects a topic that names a data source or is about tables and schemas', () => {
    expect(isUserDataTopic('Northwind database schema', [])).toBe(true) // by the word list alone
    expect(isUserDataTopic('Northwind sales history', terms)).toBe(true) // by the data source name
    expect(isUserDataTopic('customer records for 1997', [])).toBe(true)
  })

  it('accepts knowledge topics', () => {
    expect(isUserDataTopic('CERC convention for calculating PLF', terms)).toBe(false)
    expect(isUserDataTopic('anomaly threshold rule for sensor readings', terms)).toBe(false)
    expect(isUserDataTopic('company coding standard for SQL naming', terms)).toBe(false)
  })
})
