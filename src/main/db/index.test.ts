import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, setDbPath } from './index'

describe('getDb', () => {
  beforeEach(() => {
    setDbPath(':memory:')
  })

  it('loads the sqlite-vec extension', () => {
    const { vec_version: version } = getDb().prepare('select vec_version() as vec_version').get() as {
      vec_version: string
    }
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
  })

  it('supports creating and querying a vec0 virtual table', () => {
    const db = getDb()
    db.exec('CREATE VIRTUAL TABLE t USING vec0(embedding float[4])')
    const insert = db.prepare('INSERT INTO t(rowid, embedding) VALUES (?, ?)')
    const toBuf = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer)
    insert.run(BigInt(1), toBuf([1, 0, 0, 0]))
    insert.run(BigInt(2), toBuf([0, 1, 0, 0]))

    const rows = db
      .prepare('SELECT rowid, distance FROM t WHERE embedding MATCH ? AND k = 1 ORDER BY distance')
      .all(toBuf([1, 0, 0, 0])) as { rowid: number; distance: number }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].rowid).toBe(1)
    expect(rows[0].distance).toBe(0)
  })
})
