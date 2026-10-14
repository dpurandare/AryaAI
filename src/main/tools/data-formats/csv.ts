import { writeFile } from 'node:fs/promises'
import Papa from 'papaparse'
import type { Tool } from '../types'
import { resolveSource, sourceExternalPaths } from './source'

type Row = Record<string, unknown>
type WhereOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains'
interface WhereClause {
  column: string
  op: WhereOp
  value: unknown
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SAMPLE_ROWS = 3

function parseCsv(text: string): { rows: Row[]; columns: string[] } {
  const result = Papa.parse<Row>(text, { header: true, dynamicTyping: true, skipEmptyLines: true })
  return { rows: result.data, columns: result.meta.fields ?? [] }
}

function inferType(rows: Row[], column: string): string {
  for (const row of rows) {
    const value = row[column]
    if (value === undefined || value === null || value === '') continue
    return typeof value
  }
  return 'unknown (all blank in sample)'
}

function matchesWhere(row: Row, where: WhereClause[]): boolean {
  return where.every((w) => {
    const cell = row[w.column]
    switch (w.op) {
      case 'eq':
        // Deliberate loose equality: papaparse's dynamicTyping already coerced the cell to a real
        // number/boolean where possible, but a JSON-input `value` might still arrive as a string.
        return cell == w.value
      case 'ne':
        return cell != w.value
      case 'lt':
        return Number(cell) < Number(w.value)
      case 'lte':
        return Number(cell) <= Number(w.value)
      case 'gt':
        return Number(cell) > Number(w.value)
      case 'gte':
        return Number(cell) >= Number(w.value)
      case 'contains':
        return String(cell ?? '').toLowerCase().includes(String(w.value).toLowerCase())
    }
  })
}

function whereFrom(input: Record<string, unknown>): WhereClause[] {
  return Array.isArray(input.where) ? (input.where as WhereClause[]) : []
}

function aggregate(rows: Row[], column: string, op: string): number {
  const values = rows.map((r) => Number(r[column])).filter((n) => !Number.isNaN(n))
  if (op === 'count') return values.length
  if (values.length === 0) return 0
  if (op === 'sum') return values.reduce((a, b) => a + b, 0)
  if (op === 'avg') return values.reduce((a, b) => a + b, 0) / values.length
  if (op === 'min') return Math.min(...values)
  return Math.max(...values) // 'max'
}

export const parseCsvTool: Tool = {
  name: 'parse_csv',
  description:
    'Parse and work with a CSV file without pulling its raw rows into your own context. Provide ' +
    'exactly one of url, filePath, or text. action defaults to "summarize" (row count, column names/' +
    "types, a small sample). \"query\" filters/selects rows (where: [{column, op, value}], op one of " +
    'eq/ne/lt/lte/gt/gte/contains; optional columns to select, limit default 50 max 200). "count" ' +
    'counts matching rows. "aggregate" computes sum/avg/min/max/count over a numeric column, optionally ' +
    'grouped by another column. "append" adds one new row (requires filePath, since it writes back to ' +
    'the file) — this is the only action that mutates anything; there is no update/delete.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      filePath: { type: 'string', description: 'Path to a CSV file, relative to the workspace root' },
      text: { type: 'string' },
      action: { type: 'string', enum: ['summarize', 'query', 'count', 'aggregate', 'append'] },
      where: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            op: { type: 'string', enum: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains'] },
            value: {}
          },
          required: ['column', 'op', 'value']
        }
      },
      columns: { type: 'array', items: { type: 'string' }, description: 'query: columns to select (default all)' },
      limit: { type: 'number', description: `query: max rows returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      column: { type: 'string', description: 'aggregate: the numeric column to aggregate' },
      op: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count'], description: 'aggregate: the operation' },
      groupBy: { type: 'string', description: 'aggregate: optional column to group by' },
      row: { type: 'object', description: 'append: the new row, as { column: value }' }
    }
  },
  mutates: (input) => input.action === 'append',
  externalPaths: sourceExternalPaths,
  describe(input) {
    if (input.action === 'append') return `Append a row to "${String(input.filePath ?? '')}": ${JSON.stringify(input.row)}`
    return `parse_csv ${String(input.action ?? 'summarize')} on "${String(input.filePath ?? input.url ?? '(inline)')}"`
  },
  async execute(input, ctx) {
    const action = String(input.action ?? 'summarize')
    const { text, writeBackPath } = await resolveSource(input, ctx)
    const { rows, columns } = parseCsv(text)

    if (action === 'summarize') {
      const sample = rows.slice(0, SAMPLE_ROWS)
      const types = columns.map((c) => `${c}: ${inferType(rows, c)}`)
      return (
        `${rows.length} row(s), ${columns.length} column(s):\n${types.join(', ')}\n\n` +
        `Sample:\n${JSON.stringify(sample, null, 2)}`
      )
    }

    const where = whereFrom(input)
    const matched = rows.filter((r) => matchesWhere(r, where))

    if (action === 'count') return `${matched.length} row(s) match.`

    if (action === 'query') {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIMIT))
      const selectColumns = Array.isArray(input.columns) ? (input.columns as string[]) : undefined
      const page = matched.slice(0, limit).map((r) => (selectColumns ? Object.fromEntries(selectColumns.map((c) => [c, r[c]])) : r))
      const suffix = matched.length > limit ? ` (${matched.length} total, showing first ${limit})` : ''
      return `${page.length} row(s)${suffix}:\n${JSON.stringify(page, null, 2)}`
    }

    if (action === 'aggregate') {
      const column = String(input.column ?? '')
      const op = String(input.op ?? 'sum')
      const groupBy = typeof input.groupBy === 'string' ? input.groupBy : undefined
      if (!groupBy) return `${op}(${column}) = ${aggregate(matched, column, op)}`
      const groups = new Map<string, Row[]>()
      for (const row of matched) {
        const key = String(row[groupBy])
        const bucket = groups.get(key) ?? []
        bucket.push(row)
        groups.set(key, bucket)
      }
      const lines = [...groups.entries()].map(([key, groupRows]) => `${groupBy}=${key}: ${aggregate(groupRows, column, op)}`)
      return lines.join('\n')
    }

    if (action === 'append') {
      if (!writeBackPath) throw new Error('append requires a filePath inside the workspace (a url/text source, or a file outside the workspace, cannot be written back to).')
      const newRow = (input.row as Row) ?? {}
      const fullRow: Row = Object.fromEntries(columns.map((c) => [c, newRow[c] ?? '']))
      const updated = [...rows, fullRow]
      await writeFile(writeBackPath, Papa.unparse(updated, { columns }), 'utf-8')
      return `Appended 1 row. File now has ${updated.length} row(s).`
    }

    throw new Error(`Unknown action "${action}".`)
  }
}
