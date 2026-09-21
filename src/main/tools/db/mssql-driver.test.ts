import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConnect = vi.fn()
const mockQuery = vi.fn()
const mockClose = vi.fn()
const mockInput = vi.fn()

function makeRequest(): { input: typeof mockInput; query: typeof mockQuery } {
  const request = { input: mockInput, query: mockQuery }
  mockInput.mockImplementation(() => request)
  return request
}

vi.mock('mssql', () => {
  const ConnectionPool = vi.fn().mockImplementation(function FakeConnectionPool(config: unknown) {
    return { config, connect: mockConnect, request: () => makeRequest(), close: mockClose }
  })
  return { default: { ConnectionPool, NVarChar: 'NVarChar' } }
})

const { MssqlDriver } = await import('./mssql-driver')
const sql = (await import('mssql')).default

const baseConfig = { host: 'localhost', port: 1433, database: 'app', username: 'sa', password: 'secret' }

describe('MssqlDriver', () => {
  beforeEach(() => {
    mockConnect.mockReset().mockResolvedValue(undefined)
    mockQuery.mockReset()
    mockClose.mockReset().mockResolvedValue(undefined)
    mockInput.mockReset()
  })

  it('connects lazily, once, on first use', async () => {
    mockQuery.mockResolvedValue({ recordset: [], rowsAffected: [0] })
    const driver = new MssqlDriver(baseConfig)
    expect(mockConnect).not.toHaveBeenCalled()
    await driver.execute('SELECT 1')
    await driver.execute('SELECT 2')
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('defaults to encrypt + trustServerCertificate for the common local/on-prem case', () => {
    void new MssqlDriver(baseConfig)
    expect(vi.mocked(sql.ConnectionPool)).toHaveBeenCalledWith(
      expect.objectContaining({
        server: 'localhost',
        database: 'app',
        user: 'sa',
        options: { encrypt: true, trustServerCertificate: true }
      })
    )
  })

  it('introspects via INFORMATION_SCHEMA, one columns query per table', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [{ TABLE_NAME: 'users' }] })
      .mockResolvedValueOnce({ recordset: [{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }] })
    const driver = new MssqlDriver(baseConfig)

    const tables = await driver.introspectSchema()

    expect(tables).toEqual([{ name: 'users', columns: [{ name: 'id', type: 'int' }] }])
    expect(mockQuery.mock.calls[0][0]).toMatch(/INFORMATION_SCHEMA\.TABLES/)
    expect(mockQuery.mock.calls[1][0]).toMatch(/INFORMATION_SCHEMA\.COLUMNS/)
  })

  it('binds positional params by name (p1, p2, ...) matching the @p1/@p2 convention', async () => {
    mockQuery.mockResolvedValue({ recordset: [], rowsAffected: [0] })
    const driver = new MssqlDriver(baseConfig)

    await driver.execute('SELECT * FROM t WHERE a = @p1 AND b = @p2', ['x', 'y'])

    expect(mockInput).toHaveBeenNthCalledWith(1, 'p1', 'x')
    expect(mockInput).toHaveBeenNthCalledWith(2, 'p2', 'y')
  })

  it('returns rows for a SELECT, and total affected count for a write with no recordset', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [{ id: 1 }], rowsAffected: [1] })
    const driver = new MssqlDriver(baseConfig)
    expect(await driver.execute('SELECT * FROM t')).toEqual({ rows: [{ id: 1 }], rowCount: 1 })

    mockQuery.mockResolvedValueOnce({ recordset: undefined, rowsAffected: [3] })
    expect(await driver.execute('UPDATE t SET x = 1')).toEqual({ rowCount: 3 })
  })

  it('close() is a no-op if never connected', async () => {
    const driver = new MssqlDriver(baseConfig)
    await driver.close()
    expect(mockClose).not.toHaveBeenCalled()
  })
})
