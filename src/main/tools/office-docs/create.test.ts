import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { documentFraming, officeCreateDocumentTool } from './create'

/** The real `document.xml` of a .docx just written to disk — for asserting on actual Word constructs, not just "a file exists". */
async function readDocumentXml(path: string): Promise<string> {
  const buffer = await readFile(path)
  const zip = await JSZip.loadAsync(buffer)
  return zip.files['word/document.xml'].async('string')
}

/** Every `<w:t>` run's plain text content, in document order — what a reader would actually see, with no formatting markup. */
function extractTextRuns(xml: string): string[] {
  return [...xml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((m) => m[1])
}

describe('office_create_document', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-office-create-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('head and tail', () => {
    beforeEach(() => {
      documentFraming.enforce = true
    })
    afterEach(() => {
      documentFraming.enforce = false
    })

    it('refuses a bare table with no title, opening or closing', async () => {
      await expect(
        officeCreateDocumentTool.execute({ path: 'bare.docx', sections: [{ table: { headers: ['A'], rows: [['1']] } }] }, ctx)
      ).rejects.toThrow(/no head or tail.*title.*opening.*final prose-only/s)
    })

    it('accepts a title, an opening paragraph and a closing paragraph', async () => {
      const result = await officeCreateDocumentTool.execute(
        {
          path: 'framed.docx',
          title: 'Top customers',
          sections: [
            { heading: 'About this document', paragraphs: ['What it is and where the data comes from.'] },
            { heading: 'Results', table: { headers: ['A'], rows: [['1']] } },
            { heading: 'Conclusion', paragraphs: ['A is the leader.'] }
          ]
        },
        ctx
      )
      expect(result).toBe('Created documents/framed.docx.')
    })

    it('refuses a document whose text carries a [handoff: …] routing tag', async () => {
      await expect(
        officeCreateDocumentTool.execute(
          { path: 'leak.docx', title: 'T', sections: [{ paragraphs: ['Intro. [handoff: out_of_scope -> document-creator]'] }, { paragraphs: ['End.'] }] },
          ctx
        )
      ).rejects.toThrow(/handoff/)
    })

    it('does not apply to a document built from the previous answer', async () => {
      const result = await officeCreateDocumentTool.execute(
        { path: 'prev.docx', fromPreviousAnswer: true },
        { ...ctx, previousAnswerText: () => '# Hi\n\nBody' }
      )
      expect(result).toBe('Created documents/prev.docx.')
    })
  })

  it('always mutates and describes the target path', () => {
    expect(officeCreateDocumentTool.mutates).toBe(true)
    expect(officeCreateDocumentTool.describe?.({ path: 'out.docx' })).toBe('Create "out.docx"')
  })

  it('creates a real, non-empty .docx from sections, placed under documents/ automatically', async () => {
    const result = await officeCreateDocumentTool.execute(
      { path: 'report.docx', title: 'Q3 Report', sections: [{ heading: 'Summary', paragraphs: ['All good.'], bullets: ['Item one'] }] },
      ctx
    )
    expect(result).toBe('Created documents/report.docx.')
    const info = await stat(join(root, 'documents', 'report.docx'))
    expect(info.size).toBeGreaterThan(0)
  })

  it('creates a real, non-empty .pptx from slides, placed under documents/ automatically', async () => {
    const result = await officeCreateDocumentTool.execute(
      { path: 'deck.pptx', title: 'Kickoff', slides: [{ title: 'Agenda', bullets: ['Intro', 'Roadmap'] }] },
      ctx
    )
    expect(result).toBe('Created documents/deck.pptx.')
    const info = await stat(join(root, 'documents', 'deck.pptx'))
    expect(info.size).toBeGreaterThan(0)
  })

  it('renders **bold**/*italic*/`code` markdown as real run formatting, not literal markers in the text', async () => {
    // Real bug: a Paragraph built from one un-parsed string showed the raw
    // "**word**" asterisks in Word — the model writes prose the way it
    // would in chat (Markdown) regardless of this tool's plain-string schema.
    await officeCreateDocumentTool.execute(
      {
        path: 'formatting.docx',
        sections: [{ paragraphs: ['This is **bold**, this is *italic*, and this is `code`.'] }]
      },
      ctx
    )
    const xml = await readDocumentXml(join(root, 'documents', 'formatting.docx'))
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:i/>')
    const text = extractTextRuns(xml).join('')
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
    expect(text).toContain('bold')
    expect(text).toContain('italic')
    expect(text).toContain('code')
  })

  it('renders a `table` field as a real Word table with a shaded, bold header row', async () => {
    await officeCreateDocumentTool.execute(
      {
        path: 'table.docx',
        sections: [{ table: { headers: ['Metric', 'Value'], rows: [['PLF', '97%']] } }]
      },
      ctx
    )
    const xml = await readDocumentXml(join(root, 'documents', 'table.docx'))
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('D9D9D9') // header shading
    const text = extractTextRuns(xml).join('|')
    expect(text).toContain('Metric')
    expect(text).toContain('PLF')
  })

  it('auto-converts a markdown pipe table written into a plain paragraph string into a real Word table', async () => {
    // Found live: the model writes a full markdown table (`| A | B |` rows
    // plus a `|---|---|` separator) into a `paragraphs` string instead of
    // using the dedicated `table` field — this must still come out as a
    // real table, not a wall of literal pipe characters.
    await officeCreateDocumentTool.execute(
      {
        path: 'markdown-table.docx',
        sections: [
          {
            paragraphs: ['| Metric | Value |\n|--------|-------|\n| PLF | 97% |']
          }
        ]
      },
      ctx
    )
    const xml = await readDocumentXml(join(root, 'documents', 'markdown-table.docx'))
    expect(xml).toContain('<w:tbl>')
    const text = extractTextRuns(xml).join('|')
    expect(text).not.toContain('---')
    expect(text).toContain('Metric')
    expect(text).toContain('PLF')
  })

  it('auto-converts markdown bullet/numbered lines written into a plain paragraph string into real Word list items', async () => {
    await officeCreateDocumentTool.execute(
      {
        path: 'lists.docx',
        sections: [{ paragraphs: ['- First point\n- Second point', '1. Step one\n2. Step two'] }]
      },
      ctx
    )
    const xml = await readDocumentXml(join(root, 'documents', 'lists.docx'))
    expect(xml).toContain('<w:numPr>') // real list-formatted paragraphs, not literal "- "/"1. " text
    const text = extractTextRuns(xml).join('|')
    expect(text).not.toMatch(/^-\s|^\d+[.)]\s/)
    expect(text).toContain('First point')
    expect(text).toContain('Step one')
  })

  it('tolerates a { text: string } object in paragraphs/bullets/numbers instead of a plain string', async () => {
    // Found live against GPT-OSS: asked to save a long answer to Word, it
    // sent `paragraphs: [{ text: "..." }]` — a schema violation (the field
    // is declared `items: { type: 'string' }`) — which crashed with
    // "text.split is not a function" deep inside renderParagraphText.
    await officeCreateDocumentTool.execute(
      {
        path: 'malformed.docx',
        sections: [
          {
            paragraphs: [{ text: 'A wrapped paragraph.' } as unknown as string],
            bullets: [{ text: 'A wrapped bullet.' } as unknown as string],
            numbers: [{ text: 'A wrapped number.' } as unknown as string]
          }
        ]
      },
      ctx
    )
    const xml = await readDocumentXml(join(root, 'documents', 'malformed.docx'))
    const text = extractTextRuns(xml).join('|')
    expect(text).toContain('A wrapped paragraph.')
    expect(text).toContain('A wrapped bullet.')
    expect(text).toContain('A wrapped number.')
  })

  it('rejects an unsupported extension', async () => {
    await expect(officeCreateDocumentTool.execute({ path: 'notes.txt' }, ctx)).rejects.toThrow(/only supports .docx and .pptx/)
  })

  it('respects the workspace boundary', async () => {
    await expect(officeCreateDocumentTool.execute({ path: '../escape.docx' }, ctx)).rejects.toThrow(/workspace boundary/)
  })

  describe('fromPreviousAnswer', () => {
    const answer = [
      '**Northwind - a classic sample database**',
      '',
      '| What it is | Purpose |',
      '|---|---|',
      '| **Typical use cases** | CRUD tutorials<br>ER diagrams<br>Reporting demos |',
      '',
      '---',
      '',
      '### 1. Core tables',
      '',
      '| Table | Key columns | What it stores |',
      '|---|---|---|',
      '| **Orders** | `OrderID`, `OrderDate` | Order header |',
      '',
      '* Parent bullet',
      '  * Nested bullet',
      '',
      '1. First step',
      '2. Second step',
      '',
      '```',
      'SELECT * FROM Orders;',
      '```',
      '',
      '> **Note:** the data is static.'
    ].join('\n')

    it('puts every part of the answer in the document: headings, both tables with all columns, nested bullets, steps, code and the note', async () => {
      const withAnswer = { ...ctx, previousAnswerText: () => answer }
      await officeCreateDocumentTool.execute({ path: 'a.docx', title: 'Northwind', fromPreviousAnswer: true }, withAnswer)
      const xml = await readDocumentXml(join(root, 'documents', 'a.docx'))
      const text = extractTextRuns(xml).join(' ')
      for (const expected of [
        'a classic sample database', 'What it is', 'Typical use cases', 'CRUD tutorials', 'ER diagrams', 'Reporting demos',
        '1. Core tables', 'Key columns', 'OrderDate', 'Order header', 'Parent bullet', 'Nested bullet', 'First step', 'Second step',
        'SELECT * FROM Orders;', 'Note:', 'the data is static.'
      ]) {
        expect(text, `missing: ${expected}`).toContain(expected)
      }
      expect(xml.match(/<w:tbl>/g)).toHaveLength(2)
      expect(text).not.toContain('|')
      expect(text).not.toContain('<br>')
      expect(text).not.toContain('**')
      expect(xml).toContain('Heading3')
    })

    it('fails clearly when there is no previous answer, and for pptx', async () => {
      await expect(officeCreateDocumentTool.execute({ path: 'a.docx', fromPreviousAnswer: true }, ctx)).rejects.toThrow(/no previous answer/)
      await expect(officeCreateDocumentTool.execute({ path: 'a.pptx', fromPreviousAnswer: true }, { ...ctx, previousAnswerText: () => 'x' })).rejects.toThrow(/\.docx only/)
    })

    it('says so in the confirmation text', () => {
      expect(officeCreateDocumentTool.describe?.({ path: 'a.docx', fromPreviousAnswer: true })).toBe('Create "a.docx" from the previous answer')
    })
  })

  it('keeps underscores inside snake_case names and file names, but still renders real _italic_ at word edges', async () => {
    await officeCreateDocumentTool.execute(
      { path: 'u.docx', sections: [{ paragraphs: ['Read exports/01-db_query_top_customers_by_sales_39f3d4.json and Order_Details_x, then _really_ stop.'] }] },
      ctx
    )
    const xml = await readDocumentXml(join(root, 'documents', 'u.docx'))
    const text = extractTextRuns(xml).join('')
    expect(text).toContain('01-db_query_top_customers_by_sales_39f3d4.json')
    expect(text).toContain('Order_Details_x')
    expect(text).toContain('really')
    expect(text).not.toContain('_really_')
    expect(xml).toContain('<w:i/>')
  })

  it('refuses document text that mentions an internal handoff file, and writes nothing', async () => {
    const input = { path: 'h.docx', sections: [{ paragraphs: ['Retrieved from data file .sachiv-handoff/e1fe290f/01-db_query.json.'] }] }
    await expect(officeCreateDocumentTool.execute(input, ctx)).rejects.toThrow(/internal working file/)
    await expect(stat(join(root, 'documents', 'h.docx'))).rejects.toThrow()
    await expect(officeCreateDocumentTool.execute({ path: 'h2.docx', sections: [{ paragraphs: ['Clean text.'] }] }, ctx)).resolves.toMatch(/Created/)
  })
})
