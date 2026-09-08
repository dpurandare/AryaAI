import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConnect = vi.fn()
const mockQuery = vi.fn()
const mockEnd = vi.fn()

vi.mock('pg', () => {
  return {
    Client: vi.fn().mockImplementation(function FakeClient(config: unknown) {
      return { config, connect: mockConnect, query: mockQuery, end: mockEnd }
    })
  }
})

const { PostgresDriver } = await import('./postgres-driver')
const { Client } = await import('pg')

const baseConfig = { host: 'localhost', port: 5432, database: 'app', username: 'app', password: 'secret' }

describe('PostgresDriver', () => {
  beforeEach(() => {
    mockConnect.mockReset().mockResolvedValue(undefined)
    mockQuery.mockReset()
    mockEnd.mockReset().mockResolvedValue(undefined)
  })

  it('connects lazily, once, on first use', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const driver = new PostgresDriver(baseConfig)
    expect(mockConnect).not.toHaveBeenCalled()
    await driver.execute('SELECT 1')
    await driver.execute('SELECT 2')
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('sets a statement_timeout so a runaway query cannot hang forever', () => {
    void new PostgresDriver(baseConfig)
    expect(vi.mocked(Client)).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', database: 'app', user: 'app', statement_timeout: 10_000 })
    )
  })

  it('introspects tables and columns via information_schema', async () => {
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM information_schema.tables')) {
        return Promise.resolve({ rows: [{ table_name: 'users' }] })
      }
      if (sql.includes('FROM information_schema.columns')) {
        expect(params).toEqual(['public', 'users'])
        return Promise.resolve({
          rows: [
            { column_name: 'id', data_type: 'integer' },
            { column_name: 'name', data_type: 'text' }
          ]
        })
      }
      throw new Error(`unexpected query: ${sql}`)
    })

    const driver = new PostgresDriver(baseConfig)
    const tables = await driver.introspectSchema()
    expect(tables).toEqual([
      { name: 'users', columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] }
    ])
  })

  it('returns rows for a read', async () => {
    mockQuery.mockResolvedValue({ rows: [{ n: 1 }], rowCount: 1 })
    const driver = new PostgresDriver(baseConfig)
    const result = await driver.execute('SELECT 1 as n')
    expect(result).toEqual({ rows: [{ n: 1 }], rowCount: 1 })
  })

  it('returns just a row count for a write with no returned rows', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 3 })
    const driver = new PostgresDriver(baseConfig)
    const result = await driver.execute("DELETE FROM users WHERE name = 'x'")
    expect(result).toEqual({ rowCount: 3 })
  })

  it('only calls end() if a connection was actually opened', async () => {
    const driver = new PostgresDriver(baseConfig)
    await driver.close()
    expect(mockEnd).not.toHaveBeenCalled()

    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const driver2 = new PostgresDriver(baseConfig)
    await driver2.execute('SELECT 1')
    await driver2.close()
    expect(mockEnd).toHaveBeenCalledTimes(1)
  })
})
