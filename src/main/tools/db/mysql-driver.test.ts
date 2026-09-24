import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockEnd = vi.fn()
const mockCreateConnection = vi.fn()

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: mockCreateConnection
  }
}))

const { MysqlDriver } = await import('./mysql-driver')

const baseConfig = { host: 'localhost', port: 3306, database: 'app', username: 'app', password: 'secret' }

describe('MysqlDriver', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockEnd.mockReset().mockResolvedValue(undefined)
    mockCreateConnection.mockReset().mockImplementation(async (config: unknown) => ({
      config,
      query: mockQuery,
      end: mockEnd
    }))
  })

  it('connects lazily, once, on first use', async () => {
    mockQuery.mockResolvedValue([[], []])
    const driver = new MysqlDriver(baseConfig)
    expect(mockCreateConnection).not.toHaveBeenCalled()
    await driver.execute('SELECT 1')
    await driver.execute('SELECT 2')
    expect(mockCreateConnection).toHaveBeenCalledTimes(1)
  })

  it('connects with the given host/port/database/user/password', async () => {
    mockQuery.mockResolvedValue([[], []])
    await new MysqlDriver(baseConfig).execute('SELECT 1')
    expect(mockCreateConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', port: 3306, database: 'app', user: 'app', password: 'secret' })
    )
  })

  it('sets a session-level execution-time cap so a runaway query cannot hang forever', async () => {
    mockQuery.mockResolvedValue([[], []])
    await new MysqlDriver(baseConfig).execute('SELECT 1')
    expect(mockQuery).toHaveBeenCalledWith(expect.stringMatching(/SET SESSION MAX_EXECUTION_TIME=10000/))
  })

  it('introspects tables and columns via INFORMATION_SCHEMA, scoped to the current database', async () => {
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('SET SESSION')) return Promise.resolve([[], []])
      if (sql.includes('FROM INFORMATION_SCHEMA.TABLES')) {
        expect(params).toEqual(['BASE TABLE'])
        return Promise.resolve([[{ TABLE_NAME: 'users' }], []])
      }
      if (sql.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
        expect(params).toEqual(['users'])
        return Promise.resolve([
          [
            { COLUMN_NAME: 'id', DATA_TYPE: 'int' },
            { COLUMN_NAME: 'name', DATA_TYPE: 'varchar' }
          ],
          []
        ])
      }
      throw new Error(`unexpected query: ${sql}`)
    })

    const driver = new MysqlDriver(baseConfig)
    const tables = await driver.introspectSchema()
    expect(tables).toEqual([
      { name: 'users', columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar' }] }
    ])
  })

  it('returns rows for a read', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SET SESSION')) return Promise.resolve([[], []])
      return Promise.resolve([[{ n: 1 }], []])
    })
    const driver = new MysqlDriver(baseConfig)
    const result = await driver.execute('SELECT 1 as n')
    expect(result).toEqual({ rows: [{ n: 1 }], rowCount: 1 })
  })

  it('returns just an affected-row count for a write, since mysql2 returns a ResultSetHeader object, not an array', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SET SESSION')) return Promise.resolve([[], []])
      return Promise.resolve([{ affectedRows: 3 }, []])
    })
    const driver = new MysqlDriver(baseConfig)
    const result = await driver.execute("DELETE FROM users WHERE name = 'x'")
    expect(result).toEqual({ rowCount: 3 })
  })

  it('only calls end() if a connection was actually opened', async () => {
    const driver = new MysqlDriver(baseConfig)
    await driver.close()
    expect(mockEnd).not.toHaveBeenCalled()

    mockQuery.mockResolvedValue([[], []])
    const driver2 = new MysqlDriver(baseConfig)
    await driver2.execute('SELECT 1')
    await driver2.close()
    expect(mockEnd).toHaveBeenCalledTimes(1)
  })
})
