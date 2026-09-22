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
    for (const paragraph of section.paragraphs ?? []) children.push(...renderParagraphText(paragraph))
    for (const bullet of section.bullets ?? []) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: parseInlineRuns(bullet) }))
    }
    for (const number of section.numbers ?? []) {
      children.push(
        new Paragraph({ numbering: { reference: NUMBERED_LIST_REFERENCE, level: 0 }, children: parseInlineRuns(number) })
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
    'Create a new .docx or .pptx file from scratch inside the workspace — the format is chosen by the ' +
    "path's extension. This can only build a new document, never open/edit an existing one (docx/pptxgenjs " +
    "have no load capability for these formats — see office_fill_template for the one supported way back " +
    "into 'editing', via a user-authored template). For .docx, provide sections (each an optional heading " +
    'plus paragraphs/bullets/numbers/table). **bold**, *italic*/_italic_, and `code` inside any text field ' +
    "render as real formatting, not literal asterisks — write prose the normal way, it doesn't need " +
    'special handling. Use the dedicated `table` field (headers + rows) for any tabular data — it renders ' +
    'as a real Word table with a shaded header row, not a wall of pipe characters. Likewise prefer `bullets`/' +
    "`numbers` over typing \"- \"/\"1. \" into a paragraph yourself — real Word list formatting, not literal " +
    'list-marker text. For .pptx, provide slides (each an optional title, bullets, and speaker notes) — ' +
    'but this .pptx path is deliberately plain: a title and a flat bullet list per slide, no charts, ' +
    'tables, images, or real visual layout at all, regardless of what the content actually needs. Found ' +
    'live: asked for "a presentation," a model used this tool directly and produced a wall of bullet-only ' +
    'slides — a valid file, but not what a real presentation-building request wants. For an actual ' +
    'presentation (more than a handful of slides, or any real visual design — charts, tables, images, ' +
    "varied layouts), use pptx_start_deck + delegate_to_page-creator per slide instead (see this app's " +
    "own system prompt for the full flow) — reserve this tool's .pptx path for a genuinely minimal, " +
    'text-only deck where a flat bullet list is actually fine.',
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
              description:
                'Ordinary prose paragraphs. **bold**/*italic*/`code` render as real formatting. Avoid ' +
                "writing a table or list here as raw markdown text — use the table/bullets/numbers fields " +
                'instead so they render as real Word constructs, not literal pipe/dash/number characters.'
            },
            bullets: { type: 'array', items: { type: 'string' }, description: 'Real Word bulleted list items.' },
            numbers: { type: 'array', items: { type: 'string' }, description: 'Real Word numbered list items.' },
            table: {
              type: 'object',
              description: 'A real Word table — use this for any tabular data instead of a markdown pipe table.',
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
    const absPath = ctx.workspaceGuard.assertWithinWorkspace(relPath)
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
    return `Created ${relPath}.`
  }
}
