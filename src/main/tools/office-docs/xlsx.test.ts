import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { xlsxReadTool, xlsxWriteTool } from './xlsx'

describe('xlsx_write / xlsx_read', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-xlsx-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('xlsx_write always mutates; xlsx_read never does', () => {
    expect(xlsxWriteTool.mutates).toBe(true)
    expect(xlsxReadTool.mutates).toBe(false)
  })

  it('creates a new workbook, writes rows, and reads them back', async () => {
    await xlsxWriteTool.execute(
      { path: 'data.xlsx', sheet: 'Orders', rows: [['name', 'total'], ['Ada', 150], ['Grace', 200]] },
      ctx
    )
    const summary = await xlsxReadTool.execute({ path: 'data.xlsx', action: 'summarize' }, ctx)
    expect(summary).toContain('Orders: 3 row(s), 2 column(s)')

    const read = await xlsxReadTool.execute({ path: 'data.xlsx', action: 'read', sheet: 'Orders' }, ctx)
    expect(read.split('\n')).toEqual(['name\ttotal', 'Ada\t150', 'Grace\t200'])
  })

  it('load-edit-save: append adds to an existing sheet, overwrite replaces it', async () => {
    await xlsxWriteTool.execute({ path: 'data.xlsx', sheet: 'Orders', rows: [['Ada', 150]] }, ctx)

    await xlsxWriteTool.execute({ path: 'data.xlsx', sheet: 'Orders', rows: [['Grace', 200]], mode: 'append' }, ctx)
    let read = await xlsxReadTool.execute({ path: 'data.xlsx', action: 'read', sheet: 'Orders' }, ctx)
    expect(read.split('\n')).toEqual(['Ada\t150', 'Grace\t200'])

    await xlsxWriteTool.execute({ path: 'data.xlsx', sheet: 'Orders', rows: [['Bob', 50]], mode: 'overwrite' }, ctx)
    read = await xlsxReadTool.execute({ path: 'data.xlsx', action: 'read', sheet: 'Orders' }, ctx)
    expect(read.split('\n')).toEqual(['Bob\t50'])
  })

  it('respects the workspace boundary', async () => {
    await expect(xlsxWriteTool.execute({ path: '../escape.xlsx', sheet: 'S', rows: [] }, ctx)).rejects.toThrow(/workspace boundary/)
  })
})
