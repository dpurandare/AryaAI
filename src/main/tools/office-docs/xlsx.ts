import ExcelJS from 'exceljs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '../types'

const MAX_ROWS_RETURNED = 500

async function loadWorkbookIfExists(absPath: string): Promise<ExcelJS.Workbook | null> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.readFile(absPath)
    return workbook
  } catch {
    return null
  }
}

function cellValueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text)
  if (typeof value === 'object' && 'result' in value) return String((value as { result: unknown }).result)
  return String(value)
}

export const xlsxReadTool: Tool = {
  name: 'xlsx_read',
  description:
    'Read an .xlsx workbook. action "summarize" (default) lists sheet names with row/column counts — call ' +
    'this first if you don\'t already know the sheet name. action "read" returns a sheet\'s rows (capped ' +
    `at ${MAX_ROWS_RETURNED} rows) as one line per row, tab-separated.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file, relative to the workspace root' },
      action: { type: 'string', enum: ['summarize', 'read'] },
      sheet: { type: 'string', description: 'read only: sheet name (default: the first sheet)' }
    },
    required: ['path']
  },
  mutates: false,
  async execute(input, ctx) {
    const absPath = ctx.workspaceGuard.assertWithinWorkspace(String(input.path ?? ''))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(absPath)

    const action = String(input.action ?? 'summarize')
    if (action === 'summarize') {
      if (workbook.worksheets.length === 0) return '(workbook has no sheets)'
      return workbook.worksheets
        .map((ws) => `${ws.name}: ${ws.rowCount} row(s), ${ws.columnCount} column(s)`)
        .join('\n')
    }

    const sheetName = typeof input.sheet === 'string' && input.sheet ? input.sheet : undefined
    const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]
    if (!worksheet) throw new Error(sheetName ? `No sheet named "${sheetName}".` : 'Workbook has no sheets.')

    const lines: string[] = []
    let truncated = false
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > MAX_ROWS_RETURNED) {
        truncated = true
        return
      }
      lines.push((row.values as ExcelJS.CellValue[]).slice(1).map(cellValueToText).join('\t'))
    })
    if (lines.length === 0) return '(sheet has no rows)'
    return truncated ? `${lines.join('\n')}\n... (truncated at ${MAX_ROWS_RETURNED} rows)` : lines.join('\n')
  }
}

export const xlsxWriteTool: Tool = {
  name: 'xlsx_write',
  description:
    'Create or modify an .xlsx workbook — writes rows to a sheet. If the file/sheet already exists it is ' +
    'loaded first (real load-edit-save, unlike docx/pptx). mode "overwrite" (default) replaces the whole ' +
    'sheet\'s contents; mode "append" adds rows after the sheet\'s existing content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file, relative to the workspace root' },
      sheet: { type: 'string', description: 'Sheet name (created if it doesn\'t exist)' },
      rows: { type: 'array', items: { type: 'array' }, description: 'Rows to write, each an array of cell values' },
      mode: { type: 'string', enum: ['overwrite', 'append'] }
    },
    required: ['path', 'sheet', 'rows']
  },
  mutates: true,
  describe(input) {
    const rows = Array.isArray(input.rows) ? input.rows.length : 0
    return `Write ${rows} row(s) to sheet "${String(input.sheet ?? '')}" in "${String(input.path ?? '')}"`
  },
  async execute(input, ctx) {
    const relPath = String(input.path ?? '')
    const sheetName = String(input.sheet ?? '')
    const rows = Array.isArray(input.rows) ? (input.rows as unknown[][]) : []
    const mode = String(input.mode ?? 'overwrite')
    const absPath = ctx.workspaceGuard.assertWithinWorkspace(relPath)

    const workbook = (await loadWorkbookIfExists(absPath)) ?? new ExcelJS.Workbook()
    let worksheet = workbook.getWorksheet(sheetName)
    if (mode === 'overwrite' && worksheet) {
      workbook.removeWorksheet(worksheet.id)
      worksheet = undefined
    }
    if (!worksheet) worksheet = workbook.addWorksheet(sheetName)

    for (const row of rows) worksheet.addRow(row)

    await mkdir(dirname(absPath), { recursive: true })
    await workbook.xlsx.writeFile(absPath)
    return `Wrote ${rows.length} row(s) to sheet "${sheetName}" in ${relPath}.`
  }
}
