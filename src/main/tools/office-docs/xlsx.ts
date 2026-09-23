import ExcelJS from 'exceljs'
import { mkdir } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import type { Tool } from '../types'
import { resolveNewFilePath } from '../workspace-layout'

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

// Same gray as office_create_document's docx table header shading — one
// consistent "this app's header style" across every generated file type.
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' }
}
const MIN_COLUMN_WIDTH = 8
const MAX_COLUMN_WIDTH = 50

/**
 * ExcelJS has no built-in "autofit" (that needs an actual rendering engine)
 * — this is the standard estimate-from-content-length substitute, run after
 * every write so a newly-appended wider value still widens its column, not
 * just a freshly-created sheet's own initial rows.
 */
function autosizeColumns(worksheet: ExcelJS.Worksheet): void {
  worksheet.columns.forEach((column) => {
    let maxLen = MIN_COLUMN_WIDTH
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      maxLen = Math.max(maxLen, cellValueToText(cell.value).length)
    })
    column.width = Math.min(maxLen + 2, MAX_COLUMN_WIDTH)
  })
}

export const xlsxWriteTool: Tool = {
  name: 'xlsx_write',
  description:
    'Create or modify an .xlsx workbook — writes rows to a sheet. If the file/sheet already exists it is ' +
    'loaded first (real load-edit-save, unlike docx/pptx) and written back to wherever it already is; a ' +
    'brand-new file is placed under documents/ automatically regardless of the path given — the result ' +
    'names the real path used. mode "overwrite" (default) replaces the whole ' +
    "sheet's contents; mode \"append\" adds rows after the sheet's existing content. The first row written " +
    'to a sheet is automatically formatted as a real header (bold, shaded gray, frozen so it stays visible ' +
    'while scrolling) unless headerRow is set to false; every written cell gets a thin border, and columns ' +
    'are auto-sized to fit their content — set headerRow:false only when the data genuinely has no header ' +
    "(e.g. a single column of raw values), not for a plain data dump you'd still want readable.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file, relative to the workspace root' },
      sheet: { type: 'string', description: 'Sheet name (created if it doesn\'t exist)' },
      rows: { type: 'array', items: { type: 'array' }, description: 'Rows to write, each an array of cell values' },
      mode: { type: 'string', enum: ['overwrite', 'append'] },
      headerRow: {
        type: 'boolean',
        description:
          "Default true: style the first row ever written to this sheet as a header (bold/shaded/frozen). " +
          'Only applies when the sheet is new or being overwritten — never retroactively applied on append.'
      }
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
    const headerRow = input.headerRow !== false
    const absPath = resolveNewFilePath(ctx.workspaceGuard, relPath)

    const workbook = (await loadWorkbookIfExists(absPath)) ?? new ExcelJS.Workbook()
    let worksheet = workbook.getWorksheet(sheetName)
    if (mode === 'overwrite' && worksheet) {
      workbook.removeWorksheet(worksheet.id)
      worksheet = undefined
    }
    const isNewSheet = !worksheet
    if (!worksheet) worksheet = workbook.addWorksheet(sheetName)

    const firstNewRowNumber = worksheet.rowCount + 1
    for (const row of rows) worksheet.addRow(row)

    if (isNewSheet && headerRow && rows.length > 0) {
      const header = worksheet.getRow(firstNewRowNumber)
      header.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = { bold: true }
        cell.fill = HEADER_FILL
      })
      // Keeps the header visible while scrolling — ySplit is a row *count*
      // to freeze above the scrollable area, not a row index, so this is
      // right even when firstNewRowNumber is 1 (the only case it ever is,
      // since a header can only apply to a brand-new sheet).
      worksheet.views = [{ state: 'frozen', ySplit: firstNewRowNumber }]
    }

    for (let r = firstNewRowNumber; r < firstNewRowNumber + rows.length; r++) {
      worksheet.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
        cell.border = THIN_BORDER
      })
    }
    autosizeColumns(worksheet)

    await mkdir(dirname(absPath), { recursive: true })
    await workbook.xlsx.writeFile(absPath)
    return `Wrote ${rows.length} row(s) to sheet "${sheetName}" in ${relative(ctx.workspaceGuard.root, absPath)}.`
  }
}
