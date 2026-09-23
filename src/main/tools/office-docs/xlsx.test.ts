import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { xlsxReadTool, xlsxWriteTool } from './xlsx'

async function loadSheet(absPath: string, sheetName: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(absPath)
  const sheet = workbook.getWorksheet(sheetName)
  if (!sheet) throw new Error(`No sheet named "${sheetName}".`)
  return sheet
}

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
    const summary = await xlsxReadTool.execute({ path: 'documents/data.xlsx', action: 'summarize' }, ctx)
    expect(summary).toContain('Orders: 3 row(s), 2 column(s)')

    const read = await xlsxReadTool.execute({ path: 'documents/data.xlsx', action: 'read', sheet: 'Orders' }, ctx)
    expect(read.split('\n')).toEqual(['name\ttotal', 'Ada\t150', 'Grace\t200'])
  })

  it('load-edit-save: append adds to an existing sheet, overwrite replaces it', async () => {
    await xlsxWriteTool.execute({ path: 'data.xlsx', sheet: 'Orders', rows: [['Ada', 150]] }, ctx)

    await xlsxWriteTool.execute({ path: 'data.xlsx', sheet: 'Orders', rows: [['Grace', 200]], mode: 'append' }, ctx)
    let read = await xlsxReadTool.execute({ path: 'documents/data.xlsx', action: 'read', sheet: 'Orders' }, ctx)
    expect(read.split('\n')).toEqual(['Ada\t150', 'Grace\t200'])

    await xlsxWriteTool.execute({ path: 'data.xlsx', sheet: 'Orders', rows: [['Bob', 50]], mode: 'overwrite' }, ctx)
    read = await xlsxReadTool.execute({ path: 'documents/data.xlsx', action: 'read', sheet: 'Orders' }, ctx)
    expect(read.split('\n')).toEqual(['Bob\t50'])
  })

  it('places a brand-new workbook under documents/ automatically, and writes back to an existing one wherever it already is', async () => {
    const result = await xlsxWriteTool.execute(
      { path: 'sales.xlsx', sheet: 'Q1', rows: [['Region', 'Total'], ['North', 100]] },
      ctx
    )
    expect(result).toContain('documents/sales.xlsx')

    // A workbook the user (or an earlier session) already placed elsewhere
    // must be appended to there, not relocated into documents/ just because
    // of its extension.
    await mkdir(join(root, 'archive'), { recursive: true })
    const existing = new ExcelJS.Workbook()
    existing.addWorksheet('Old').addRow(['legacy'])
    await existing.xlsx.writeFile(join(root, 'archive', 'legacy.xlsx'))

    const appendResult = await xlsxWriteTool.execute(
      { path: 'archive/legacy.xlsx', sheet: 'Old', rows: [['appended']], mode: 'append' },
      ctx
    )
    expect(appendResult).toContain('archive/legacy.xlsx')
    const sheet = await loadSheet(join(root, 'archive', 'legacy.xlsx'), 'Old')
    expect(sheet.getRow(2).getCell(1).value).toBe('appended')
  })

  it('respects the workspace boundary', async () => {
    await expect(xlsxWriteTool.execute({ path: '../escape.xlsx', sheet: 'S', rows: [] }, ctx)).rejects.toThrow(/workspace boundary/)
  })

  it('formats a fresh sheet with a bold/shaded/frozen header row, bordered cells, and auto-sized columns', async () => {
    // Found live: the tool wrote plain, unstyled cells — no bold header, no
    // fill color, no borders, default column widths — a bland dump next to
    // office_create_document's already-styled Word tables.
    const absPath = join(root, 'documents', 'report.xlsx')
    await xlsxWriteTool.execute(
      {
        path: 'report.xlsx',
        sheet: 'Summary',
        rows: [
          ['Region', 'Revenue'],
          ['North', 150000],
          ['A much longer value that should widen this column', 1]
        ]
      },
      ctx
    )
    const sheet = await loadSheet(absPath, 'Summary')

    const header = sheet.getRow(1)
    header.eachCell((cell) => {
      expect(cell.font?.bold).toBe(true)
      expect((cell.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFD9D9D9')
    })

    // Every written cell (header and data) gets a real border, not just the header.
    for (let r = 1; r <= 3; r++) {
      sheet.getRow(r).eachCell((cell) => {
        expect(cell.border?.top?.style).toBe('thin')
        expect(cell.border?.bottom?.style).toBe('thin')
      })
    }

    // A data row must NOT get the header's bold/fill treatment.
    const dataCell = sheet.getRow(2).getCell(1)
    expect(dataCell.font?.bold).not.toBe(true)

    expect(sheet.views).toMatchObject([{ state: 'frozen', ySplit: 1 }])

    // Column 1's width reflects the long value written into it, not a flat default.
    const col1Width = sheet.getColumn(1).width ?? 0
    expect(col1Width).toBeGreaterThan(20)
  })

  it('headerRow:false skips header styling entirely, on an otherwise identically-formatted sheet', async () => {
    const absPath = join(root, 'documents', 'raw.xlsx')
    await xlsxWriteTool.execute(
      { path: 'raw.xlsx', sheet: 'Values', rows: [['first'], ['second']], headerRow: false },
      ctx
    )
    const sheet = await loadSheet(absPath, 'Values')

    const row1 = sheet.getRow(1)
    expect(row1.getCell(1).font?.bold).not.toBe(true)
    // ExcelJS/the saved file format normalizes an unset fill to an explicit
    // "no pattern" on round-trip, rather than leaving it truly undefined.
    expect((row1.getCell(1).fill as ExcelJS.FillPattern | undefined)?.pattern ?? 'none').toBe('none')
    // Borders still apply regardless of headerRow — that's a plain-grid
    // concern, not a "is this a header" one.
    expect(row1.getCell(1).border?.top?.style).toBe('thin')
    expect(sheet.views ?? []).toEqual([])
  })

  it('append mode never retroactively re-styles the existing header, only borders/sizes the newly appended rows', async () => {
    const absPath = join(root, 'documents', 'orders.xlsx')
    await xlsxWriteTool.execute(
      { path: 'orders.xlsx', sheet: 'Orders', rows: [['Name', 'Total'], ['Ada', 150]] },
      ctx
    )
    await xlsxWriteTool.execute(
      { path: 'orders.xlsx', sheet: 'Orders', rows: [['Grace', 200]], mode: 'append' },
      ctx
    )
    const sheet = await loadSheet(absPath, 'Orders')

    // Still exactly one styled header row, not two.
    expect(sheet.getRow(1).getCell(1).font?.bold).toBe(true)
    expect(sheet.getRow(2).getCell(1).font?.bold).not.toBe(true)
    const appendedCell = sheet.getRow(3).getCell(1)
    expect(appendedCell.font?.bold).not.toBe(true)
    expect(appendedCell.border?.top?.style).toBe('thin')
    expect(sheet.views).toMatchObject([{ state: 'frozen', ySplit: 1 }])
  })
})
