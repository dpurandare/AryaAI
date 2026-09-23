import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../../security/workspace-guard'
import type { ToolContext } from '../types'
import { officeCreateDocumentTool } from './create'
import { officeReadDocumentTool } from './read'

describe('office_read_document', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-office-read-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is read-only', () => {
    expect(officeReadDocumentTool.mutates).toBe(false)
  })

  it('round-trips a real .docx created by office_create_document', async () => {
    await officeCreateDocumentTool.execute(
      { path: 'report.docx', title: 'Q3 Report', sections: [{ heading: 'Summary', paragraphs: ['All good.'], bullets: ['Item one'] }] },
      ctx
    )
    const text = await officeReadDocumentTool.execute({ path: 'documents/report.docx' }, ctx)
    expect(text).toContain('Q3 Report')
    expect(text).toContain('Summary')
    expect(text).toContain('All good.')
    expect(text).toContain('Item one')
  })

  it('round-trips a real .pptx created by office_create_document, slide by slide', async () => {
    await officeCreateDocumentTool.execute(
      { path: 'deck.pptx', title: 'Kickoff', slides: [{ title: 'Agenda', bullets: ['Intro', 'Roadmap'] }] },
      ctx
    )
    const text = await officeReadDocumentTool.execute({ path: 'documents/deck.pptx' }, ctx)
    expect(text).toContain('Slide 1:')
    expect(text).toContain('Kickoff')
    expect(text).toContain('Slide 2:')
    expect(text).toContain('Agenda')
    expect(text).toContain('Intro')
    expect(text).toContain('Roadmap')
  })

  it('rejects an unsupported extension', async () => {
    await expect(officeReadDocumentTool.execute({ path: 'notes.txt' }, ctx)).rejects.toThrow(/only supports .docx and .pptx/)
  })
})
