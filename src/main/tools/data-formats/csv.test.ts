import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import { parseCsvTool } from './csv'
import type { ToolContext } from '../types'

const SAMPLE_CSV = 'name,status,revenue\nAda,active,150.5\nGrace,active,200\nBob,inactive,50\n'

describe('parse_csv', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-parse-csv-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
    await writeFile(join(root, 'orders.csv'), SAMPLE_CSV, 'utf-8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('mutates only for the append action', () => {
    const mutates = parseCsvTool.mutates as (input: Record<string, unknown>) => boolean
    expect(mutates({ action: 'summarize' })).toBe(false)
    expect(mutates({ action: 'query' })).toBe(false)
    expect(mutates({})).toBe(false)
    expect(mutates({ action: 'append' })).toBe(true)
  })

  it('summarizes row count, columns, and a sample by default', async () => {
    const result = await parseCsvTool.execute({ filePath: 'orders.csv' }, ctx)
    expect(result).toContain('3 row(s), 3 column(s)')
    expect(result).toContain('name: string')
    expect(result).toContain('revenue: number')
    expect(result).toContain('Ada')
  })

  it('counts rows matching a where clause', async () => {
    const result = await parseCsvTool.execute(
      { filePath: 'orders.csv', action: 'count', where: [{ column: 'status', op: 'eq', value: 'active' }] },
      ctx
    )
    expect(result).toBe('2 row(s) match.')
  })

  it('queries with a where filter and column selection', async () => {
    const result = await parseCsvTool.execute(
      {
        filePath: 'orders.csv',
        action: 'query',
        where: [{ column: 'status', op: 'eq', value: 'inactive' }],
        columns: ['name']
      },
      ctx
    )
    expect(result).toContain('1 row(s)')
    expect(result).toContain('"name": "Bob"')
    expect(result).not.toContain('status')
  })

  it('supports the gt/lt/contains operators', async () => {
    const gt = await parseCsvTool.execute(
      { filePath: 'orders.csv', action: 'count', where: [{ column: 'revenue', op: 'gt', value: 100 }] },
      ctx
    )
    expect(gt).toBe('2 row(s) match.')

    const contains = await parseCsvTool.execute(
      { filePath: 'orders.csv', action: 'count', where: [{ column: 'name', op: 'contains', value: 'ra' }] },
      ctx
    )
    expect(contains).toBe('1 row(s) match.')
  })

  it('aggregates sum/avg/min/max/count over a numeric column', async () => {
    expect(await parseCsvTool.execute({ filePath: 'orders.csv', action: 'aggregate', column: 'revenue', op: 'sum' }, ctx)).toBe(
      'sum(revenue) = 400.5'
    )
    expect(await parseCsvTool.execute({ filePath: 'orders.csv', action: 'aggregate', column: 'revenue', op: 'count' }, ctx)).toBe(
      'count(revenue) = 3'
    )
  })

  it('aggregates grouped by another column', async () => {
    const result = await parseCsvTool.execute(
      { filePath: 'orders.csv', action: 'aggregate', column: 'revenue', op: 'sum', groupBy: 'status' },
      ctx
    )
    expect(result).toContain('status=active: 350.5')
    expect(result).toContain('status=inactive: 50')
  })

  it('appends a new row and writes it back to the file', async () => {
    const result = await parseCsvTool.execute(
      { filePath: 'orders.csv', action: 'append', row: { name: 'Zoe', status: 'active', revenue: 75 } },
      ctx
    )
    expect(result).toBe('Appended 1 row. File now has 4 row(s).')

    const written = await readFile(join(root, 'orders.csv'), 'utf-8')
    expect(written).toContain('Zoe')

    const recount = await parseCsvTool.execute({ filePath: 'orders.csv', action: 'count' }, ctx)
    expect(recount).toBe('4 row(s) match.')
  })

  it('rejects append when the source is not a file', async () => {
    await expect(
      parseCsvTool.execute({ text: SAMPLE_CSV, action: 'append', row: { name: 'X' } }, ctx)
    ).rejects.toThrow(/append requires filePath/)
  })
})
