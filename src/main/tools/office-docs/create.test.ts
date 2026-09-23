import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { officeCreateDocumentTool } from './create'

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

  it('always mutates and describes the target path', () => {
    expect(officeCreateDocumentTool.mutates).toBe(true)
    expect(officeCreateDocumentTool.describe?.({ path: 'out.docx' })).toBe('Create "out.docx"')
  })

  it('creates a real, non-empty .docx from sections', async () => {
    const result = await officeCreateDocumentTool.execute(
      { path: 'report.docx', title: 'Q3 Report', sections: [{ heading: 'Summary', paragraphs: ['All good.'], bullets: ['Item one'] }] },
      ctx
    )
    expect(result).toBe('Created report.docx.')
    const info = await stat(join(root, 'report.docx'))
    expect(info.size).toBeGreaterThan(0)
  })

  it('creates a real, non-empty .pptx from slides', async () => {
    const result = await officeCreateDocumentTool.execute(
      { path: 'deck.pptx', title: 'Kickoff', slides: [{ title: 'Agenda', bullets: ['Intro', 'Roadmap'] }] },
      ctx
    )
    expect(result).toBe('Created deck.pptx.')
    const info = await stat(join(root, 'deck.pptx'))
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
    const xml = await readDocumentXml(join(root, 'formatting.docx'))
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
    const xml = await readDocumentXml(join(root, 'table.docx'))
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
    const xml = await readDocumentXml(join(root, 'markdown-table.docx'))
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
    const xml = await readDocumentXml(join(root, 'lists.docx'))
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
    const xml = await readDocumentXml(join(root, 'malformed.docx'))
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
})
