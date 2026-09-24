import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PizZip from 'pizzip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { officeCreateDocumentTool } from './create'
import { extractDocxRuns, extractPptxRuns } from './extract'

describe('extractDocxRuns / extractPptxRuns', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-office-extract-runs-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('extractDocxRuns returns each real <w:t> text run, at run granularity (not flattened plain text)', async () => {
    await officeCreateDocumentTool.execute(
      {
        path: 'invoice.docx',
        title: 'Invoice',
        sections: [{ paragraphs: ['Invoice Date: 2026-09-24', 'Amount Due: $1,250.00'] }]
      },
      ctx
    )
    const buffer = await readFile(join(root, 'documents', 'invoice.docx'))
    const runs = await extractDocxRuns(buffer)
    expect(runs).toContain('Invoice Date: 2026-09-24')
    expect(runs).toContain('Amount Due: $1,250.00')
  })

  it('extractDocxRuns returns an empty array for a real zip that has no word/document.xml part', async () => {
    const zip = new PizZip()
    zip.file('unrelated.txt', 'hello')
    const buffer = zip.generate({ type: 'nodebuffer' })
    const runs = await extractDocxRuns(buffer)
    expect(runs).toEqual([])
  })

  it('extractPptxRuns returns runs grouped per slide, in slide order (a title produces its own leading slide)', async () => {
    await officeCreateDocumentTool.execute(
      {
        path: 'deck.pptx',
        title: 'Kickoff',
        slides: [
          { title: 'Agenda', bullets: ['Intro'] },
          { title: 'Budget', bullets: ['Total: $1,250.00'] }
        ]
      },
      ctx
    )
    const buffer = await readFile(join(root, 'documents', 'deck.pptx'))
    const slides = await extractPptxRuns(buffer)
    expect(slides).toHaveLength(3)
    expect(slides[0]).toContain('Kickoff')
    expect(slides[1]).toContain('Agenda')
    expect(slides[1]).toContain('Intro')
    expect(slides[2]).toContain('Budget')
    expect(slides[2]).toContain('Total: $1,250.00')
  })
})
