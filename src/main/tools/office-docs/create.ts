import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import pptxgen from 'pptxgenjs'
import type { Tool } from '../types'
import { resolveNewFilePath, workspaceRelativePath } from '../workspace-layout'

interface DocxTable {
  headers?: string[]
  rows: string[][]
}

interface DocxSection {
  heading?: string
  paragraphs?: string[]
  bullets?: string[]
  numbers?: string[]
  table?: DocxTable
}

interface PptxSlide {
  title?: string
  bullets?: string[]
  notes?: string
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

const NUMBERED_LIST_REFERENCE = 'office-create-document-numbered-list'

/**
 * Splits **bold**, *italic* (or _italic_), and `code` markdown spans into real
 * TextRuns instead of leaving the literal asterisks/underscores/backticks
 * in the document. Found live: asked for prose, the model reliably writes
 * it the same way it would in chat — Markdown — regardless of this tool's
 * plain-string schema; a Paragraph built from one un-parsed string just
 * shows the raw "**word**" in Word. Deliberately simple/non-nested (no
 * ***bold italic***) — real output from this app has never needed more
 * than one level, and a full CommonMark inline parser is overkill here.
 */
const INLINE_MARKDOWN = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`(.+?)`/g

function parseInlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  let lastIndex = 0
  for (const match of text.matchAll(INLINE_MARKDOWN)) {
    const index = match.index ?? 0
    if (index > lastIndex) runs.push(new TextRun(text.slice(lastIndex, index)))
    const [, bold1, bold2, italic1, italic2, code] = match
    if (bold1 !== undefined || bold2 !== undefined) {
      runs.push(new TextRun({ text: bold1 ?? bold2, bold: true }))
    } else if (italic1 !== undefined || italic2 !== undefined) {
      runs.push(new TextRun({ text: italic1 ?? italic2, italics: true }))
    } else if (code !== undefined) {
      runs.push(new TextRun({ text: code, font: 'Courier New' }))
    }
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) runs.push(new TextRun(text.slice(lastIndex)))
  return runs.length ? runs : [new TextRun('')]
}

/**
 * Coerces one array entry from a string-array field (`paragraphs`/`bullets`/
 * `numbers`) to a real string. Found live against GPT-OSS: asked to save a
 * long answer to Word, it sent `paragraphs: [{ text: "..." }]` instead of
 * `paragraphs: ["..."]` — a schema violation (the field is declared
 * `items: { type: 'string' }`) smaller/local models reach for often enough
 * that it's worth tolerating here, not just documenting in the schema.
 * Left unguarded, `renderParagraphText`'s `text.split('\n')` threw
 * `text.split is not a function` on the object, which — because dispatchTool
 * had no timeout of its own at the time (see orchestrator.ts's
 * TOOL_EXECUTE_TIMEOUT_MS) — surfaced only after the turn had already sat
 * stuck for the better part of an hour, not as an immediate, recoverable
 * tool error.
 */
function asText(entry: unknown): string {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string') {
    return (entry as { text: string }).text
  }
  return String(entry ?? '')
}

function isTableRowLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line)
}

function splitTableRowLine(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function buildTable(table: DocxTable): Table {
  const rows: TableRow[] = []
  if (table.headers?.length) {
    rows.push(
      new TableRow({
        tableHeader: true,
        children: table.headers.map(
          (header) =>
            new TableCell({
              shading: { fill: 'D9D9D9' },
              children: [new Paragraph({ children: [new TextRun({ text: header, bold: true })] })]
            })
        )
      })
    )
  }
  for (const row of table.rows) {
    rows.push(
      new TableRow({
        children: row.map((cell) => new TableCell({ children: [new Paragraph({ children: parseInlineRuns(cell) })] }))
      })
    )
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })
}

/**
 * A single `paragraphs` string can itself contain a markdown table, a
 * bulleted/numbered list, or a mix of these with plain prose — found live,
 * repeatedly: the model writes multi-line markdown-shaped content into one
 * paragraph string rather than using the dedicated `bullets`/`numbers`/
 * `table` fields, e.g. real `| Metric | Value |` rows or `- item`/`1. item`
 * lines. Detecting and converting these here means the output still comes
 * out as real Word tables/lists even when the model doesn't use the
 * structured fields as intended.
 */
function renderParagraphText(text: string): (Paragraph | Table)[] {
  const lines = text.split('\n')
  const blocks: (Paragraph | Table)[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (isTableRowLine(line)) {
      const tableLines: string[] = []
      while (i < lines.length && (isTableRowLine(lines[i]) || isTableSeparatorLine(lines[i]))) {
        tableLines.push(lines[i])
        i++
      }
      const dataLines = tableLines.filter((l) => !isTableSeparatorLine(l))
      const hasHeader = isTableSeparatorLine(tableLines[1] ?? '')
      const parsedRows = dataLines.map(splitTableRowLine)
      blocks.push(
        buildTable(
          hasHeader ? { headers: parsedRows[0], rows: parsedRows.slice(1) } : { rows: parsedRows }
        )
      )
      continue
    }
    const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bulletMatch) {
      blocks.push(new Paragraph({ bullet: { level: 0 }, children: parseInlineRuns(bulletMatch[1]) }))
      i++
      continue
    }
    const numberedMatch = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numberedMatch) {
      blocks.push(
        new Paragraph({
          numbering: { reference: NUMBERED_LIST_REFERENCE, level: 0 },
          children: parseInlineRuns(numberedMatch[1])
        })
      )
      i++
      continue
    }
    blocks.push(new Paragraph({ children: parseInlineRuns(line) }))
    i++
  }
  return blocks
}

async function buildDocx(title: string | undefined, sections: DocxSection[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = []
  if (title) children.push(new Paragraph({ children: parseInlineRuns(title), heading: HeadingLevel.TITLE }))
  for (const section of sections) {
    if (section.heading) {
      children.push(new Paragraph({ children: parseInlineRuns(section.heading), heading: HeadingLevel.HEADING_1 }))
    }
    for (const paragraph of section.paragraphs ?? []) children.push(...renderParagraphText(asText(paragraph)))
    for (const bullet of section.bullets ?? []) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: parseInlineRuns(asText(bullet)) }))
    }
    for (const number of section.numbers ?? []) {
      children.push(
        new Paragraph({
          numbering: { reference: NUMBERED_LIST_REFERENCE, level: 0 },
          children: parseInlineRuns(asText(number))
        })
      )
    }
    if (section.table) children.push(buildTable(section.table))
  }
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: NUMBERED_LIST_REFERENCE,
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }]
        }
      ]
    },
    sections: [{ children }]
  })
  return Packer.toBuffer(doc)
}

async function buildPptx(absPath: string, title: string | undefined, slides: PptxSlide[]): Promise<void> {
  const pres = new pptxgen()
  if (title) {
    const titleSlide = pres.addSlide()
    titleSlide.addText(title, { x: 0.5, y: 2.5, w: '90%', h: 1, fontSize: 32, bold: true, align: 'center' })
  }
  for (const slide of slides) {
    const s = pres.addSlide()
    if (slide.title) s.addText(slide.title, { x: 0.5, y: 0.3, w: '90%', h: 0.75, fontSize: 24, bold: true })
    if (slide.bullets?.length) {
      s.addText(
        slide.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.2, w: '90%', h: 4, fontSize: 16 }
      )
    }
    if (slide.notes) s.addNotes(slide.notes)
  }
  await pres.writeFile({ fileName: absPath })
}

export const officeCreateDocumentTool: Tool = {
  name: 'office_create_document',
  description:
    'Create a new .docx or .pptx file from scratch inside the workspace — the format follows the path\'s extension. ' +
    'It is placed under documents/ regardless of the path given (unless a file already exists at that path, which it ' +
    'then overwrites); the result names the real path. It cannot open or edit an existing document — the one way back ' +
    'into editing is office_fill_template with a user-authored template. For .docx give sections (each an optional ' +
    'heading plus paragraphs / bullets / numbers / table); **bold**, *italic* and `code` in any text render as real ' +
    'formatting. Use `table` (headers + rows) for tabular data and `bullets`/`numbers` for lists, never markdown ' +
    'pipes or typed "- "/"1. " markers. It cannot embed images or charts. For .pptx give slides (title, bullets, ' +
    'notes), but this path is deliberately plain — a flat bullet list per slide, no charts, tables, images or layout. ' +
    'For a real presentation (more than a few slides, or any visual design) use pptx_start_deck + ' +
    'delegate_to_page-creator per slide instead; keep this tool\'s .pptx path for a minimal text-only deck.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Output path relative to the workspace root, .docx or .pptx' },
      title: { type: 'string', description: 'Optional document title / opening title slide' },
      sections: {
        type: 'array',
        description: 'docx only',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            paragraphs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ordinary prose paragraphs (inline **bold** / *italic* / `code` render). Not for tables or lists.'
            },
            bullets: { type: 'array', items: { type: 'string' }, description: 'Real Word bulleted list items.' },
            numbers: { type: 'array', items: { type: 'string' }, description: 'Real Word numbered list items.' },
            table: {
              type: 'object',
              description: 'A real Word table.',
              properties: {
                headers: { type: 'array', items: { type: 'string' }, description: 'Optional header row (shaded, bold).' },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Data rows, each an array of cell values.' }
              },
              required: ['rows']
            }
          }
        }
      },
      slides: {
        type: 'array',
        description: 'pptx only',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' }
          }
        }
      }
    },
    required: ['path']
  },
  mutates: true,
  describe(input) {
    return `Create "${String(input.path ?? '')}"`
  },
  async execute(input, ctx) {
    const relPath = String(input.path ?? '')
    const extension = extensionOf(relPath)
    if (extension !== 'docx' && extension !== 'pptx') {
      throw new Error(`office_create_document only supports .docx and .pptx (got "${relPath}").`)
    }
    const absPath = resolveNewFilePath(ctx.workspaceGuard, relPath)
    await mkdir(dirname(absPath), { recursive: true })
    const title = typeof input.title === 'string' ? input.title : undefined

    if (extension === 'docx') {
      const sections = Array.isArray(input.sections) ? (input.sections as DocxSection[]) : []
      const buffer = await buildDocx(title, sections)
      await writeFile(absPath, buffer)
    } else {
      const slides = Array.isArray(input.slides) ? (input.slides as PptxSlide[]) : []
      await buildPptx(absPath, title, slides)
    }
    return `Created ${workspaceRelativePath(ctx.workspaceGuard.root, absPath)}.`
  }
}
